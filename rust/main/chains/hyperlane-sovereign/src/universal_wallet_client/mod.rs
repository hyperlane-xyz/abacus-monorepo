use anyhow::{bail, Context, Result};
use base64::prelude::BASE64_STANDARD;
use base64::Engine;
use futures::StreamExt;
use reqwest::{Client, ClientBuilder};
use serde_json::{json, Value};
use sov_universal_wallet::schema::{RollupRoots, Schema};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::time::{timeout_at, Instant};

mod crypto;
mod tx_state;
mod types;
pub mod utils;

use types::TxStatus;

/// A `UnversalClient` for interacting with the Universal Wallet.
#[derive(Clone, Debug)]
pub struct UniversalClient {
    api_url: String,
    chain_hash: [u8; 32],
    chain_id: u64,
    http_client: Client,
    crypto: crypto::Crypto,
    #[allow(dead_code)]
    address: String,
}

impl UniversalClient {
    /// Create a new `UniversalClient`.
    async fn new(api_url: &str, crypto: crypto::Crypto, chain_id: u64) -> anyhow::Result<Self> {
        let http_client = ClientBuilder::default().build()?;
        let mut schema = Self::fetch_schema(api_url, &http_client).await?;

        Ok(Self {
            api_url: api_url.to_string(),
            chain_hash: schema.chain_hash()?,
            chain_id,
            http_client,
            address: crypto.address()?,
            crypto,
        })
    }

    /// Build a transaction and submit it to the rollup.
    async fn build_and_submit(&self, call_message: Value) -> Result<(String, String)> {
        let utx = self.build_tx_json(&call_message);
        let tx = self.sign_tx(utx).await?;
        let body = self.serialise_tx(&tx).await?;
        let hash = self.submit_tx(body.clone()).await?;
        self.wait_for_tx(hash.clone()).await?;

        Ok((hash, body))
    }

    async fn wait_for_tx(&self, tx_hash: String) -> Result<()> {
        let mut slot_subscription = self.subscribe_to_tx_status_updates(tx_hash).await?;

        let end_wait_time = Instant::now() + Duration::from_secs(300);
        let start_wait = Instant::now();

        while Instant::now() < end_wait_time {
            match timeout_at(end_wait_time, slot_subscription.next()).await? {
                Some(Ok(tx_info)) => match tx_info.status {
                    TxStatus::Processed | TxStatus::Finalized => return Ok(()),
                    TxStatus::Dropped => bail!("Transaction dropped"),
                    _ => continue,
                },
                Some(Err(e)) => bail!(format!("Received stream error: {e:?}")),
                None => bail!("Subscription closed unexpectedly"),
            }
        }
        anyhow::bail!(
            "Giving up waiting for target batch to be published after {:?}",
            start_wait.elapsed()
        );
    }

    fn build_tx_json(&self, call_message: &Value) -> Value {
        json!({
            "runtime_call": call_message,
            "generation": self.get_generation(),
            "details": {
                "max_priority_fee_bips": 100,
                "max_fee": 100_000_000,
                "gas_limit": serde_json::Value::Null,
                "chain_id": self.chain_id
            }
        })
    }

    /// Query the Universale Wallet for the encoded transaction body.
    async fn encoded_call_message(&self, call_message: &Value) -> Result<String> {
        let schema = Self::fetch_schema(&self.api_url, &self.http_client).await?;
        let rtc_index = schema.rollup_expected_index(RollupRoots::RuntimeCall)?;
        let bytes = schema.json_to_borsh(rtc_index, &call_message.to_string())?;

        Ok(format!("{bytes:?}"))
    }

    async fn sign_tx(&self, mut utx_json: Value) -> Result<Value> {
        let schema = Self::fetch_schema(&self.api_url, &self.http_client).await?;
        let utx_index = schema.rollup_expected_index(RollupRoots::UnsignedTransaction)?;
        let mut utx_bytes = schema.json_to_borsh(utx_index, &utx_json.to_string())?;
        utx_bytes.extend_from_slice(&self.chain_hash);

        let signature = self.crypto.sign(&utx_bytes);

        if let Some(obj) = utx_json.as_object_mut() {
            obj.insert("signature".to_string(), json!({"msg_sig": signature}));
            obj.insert(
                "pub_key".to_string(),
                json!({
                    "pub_key": self.crypto.public_key()
                }),
            );
        }
        Ok(utx_json)
    }

    async fn serialise_tx(&self, tx_json: &Value) -> Result<String> {
        let schema = Self::fetch_schema(&self.api_url, &self.http_client).await?;
        let tx_index = schema.rollup_expected_index(RollupRoots::Transaction)?;
        let tx_bytes = schema.json_to_borsh(tx_index, &tx_json.to_string())?;

        Ok(BASE64_STANDARD.encode(&tx_bytes))
    }

    async fn submit_tx(&self, tx: String) -> Result<String> {
        let url = format!("{}/sequencer/txs", self.api_url);
        let resp = self
            .http_client
            .post(url)
            .json(&json!({"body": tx}))
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let error_text = resp
                .text()
                .await
                .unwrap_or_else(|_| "Unknown error".to_string());
            bail!("Request failed with status {}: {}", status, error_text);
        }

        let parsed_response: serde_json::Value = resp.json().await?;

        let Some(id) = parsed_response
            .get("data")
            .and_then(|data| data.get("id"))
            .and_then(|id| id.as_str())
        else {
            bail!("ID not found in response");
        };
        Ok(id.to_string())
    }

    /// Query the rollup REST API for it's schema, in JSON format (used to serialise json transactions into borsh ones)
    async fn fetch_schema(api_url: &str, client: &Client) -> Result<Schema> {
        let resp = client
            .get(format!("{api_url}/rollup/schema"))
            .send()
            .await
            .context("querying rollup schema")?
            .error_for_status()?;
        let schema_json: Value = resp.json().await?;
        let schema_text = schema_json["data"].to_string();

        let schema = Schema::from_json(&schema_text).context("parsing rollup schema")?;
        Ok(schema)
    }

    /// Get the current 'generation' - the timestamp in seconds suffices;
    /// # Panics
    ///
    /// Will panic if system time is before epoch
    #[must_use]
    fn get_generation(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("Time went backwards")
            .as_secs()
    }
}
