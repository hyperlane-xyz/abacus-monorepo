use crate::universal_wallet_client::{crypto, UniversalClient};
use hyperlane_core::{
    Announcement, ChainCommunicationError, ChainResult, Encode, HyperlaneMessage, SignedType,
};
use serde_json::{json, Value};
use std::env;
use tokio::fs;

async fn key_from_key_file(key_file_path: &str) -> ChainResult<[u8; 32]> {
    let data = fs::read_to_string(key_file_path).await.map_err(|e| {
        ChainCommunicationError::CustomError(format!(
            "Failed to read file at {key_file_path}: {e:?}"
        ))
    })?;
    let outer_value: serde_json::Value = serde_json::from_str(&data)?;
    let inner_value = outer_value["private_key"]["key_pair"].clone();
    let bytes: [u8; 32] = serde_json::from_value(inner_value)?;
    Ok(bytes)
}

pub async fn get_universal_client(api_url: &str, domain: u32) -> ChainResult<UniversalClient> {
    let key = "TOKEN_KEY_FILE";
    let key_file = env::var(key).map_err(|e| {
        ChainCommunicationError::CustomError(format!(
            "Environment variable {key} does not exist: {e:?}"
        ))
    })?;
    let key_bytes = key_from_key_file(&key_file).await?;

    let crypto = crypto::Crypto {
        private_key: crypto::PrivateKey::Ed25519(key_bytes.into()),
        hasher: crypto::Hasher::Sha256,
        address_type: crypto::Address::Bech32m {
            size_bytes: 28,
            hrp: bech32::Hrp::parse("sov").unwrap(),
        },
    };
    UniversalClient::new(api_url, crypto.clone(), u64::from(domain))
        .await
        .map_err(|e| {
            ChainCommunicationError::CustomError(format!(
                "Failed to create Universal Client: {e:?}"
            ))
        })
}

pub async fn get_simulate_json_query(
    message: &HyperlaneMessage,
    metadata: &[u8],
    client: &UniversalClient,
) -> ChainResult<Value> {
    let call_message = json!({
        "mailbox": {
            "process": {
                "metadata": metadata.to_vec(),
                "message": message.to_vec(),
            }
        },
    });

    let encoded_call_message = client
        .encoded_call_message(&call_message)
        .await
        .map_err(|e| ChainCommunicationError::CustomError(format!("{e:?}")))?;

    let res = json!(
        {
            "body":{
                "details":{
                    "chain_id":message.destination,
                    "max_fee":100_000_000,
                    "max_priority_fee_bips":0
                },
                "encoded_call_message":encoded_call_message,
                "nonce":message.nonce,
                "generation":0, // get _generation
                "sender_pub_key": "\"f8ad2437a279e1c8932c07358c91dc4fe34864a98c6c25f298e2a0199c1509ff\""
            }
        }
    );
    Ok(res)
}

pub async fn get_submit_body_string(
    message: &HyperlaneMessage,
    metadata: &[u8],
    client: &UniversalClient,
) -> ChainResult<String> {
    let call_message = json!({
        "mailbox": {
            "process": {
                "metadata": metadata.to_vec(),
                "message": message.to_vec(),
            }
        },
    });

    let res = client
        .build_and_submit(call_message)
        .await
        .map_err(|e| ChainCommunicationError::CustomError(format!("{e:?}")))?;

    Ok(res.1)
}

pub async fn announce_validator(
    announcement: SignedType<Announcement>,
    client: &UniversalClient,
) -> ChainResult<String> {
    let sig_hyperlane = announcement.signature;
    let sig_bytes: [u8; 65] = sig_hyperlane.into();
    let call_message = json!({
        "mailbox_va": {
            "announce": {
                "validator_address": announcement.value.validator,
                "storage_location": announcement.value.storage_location,
                "signature": sig_bytes.to_vec()
            }
        },
    });

    let res = client
        .build_and_submit(call_message)
        .await
        .map_err(|e| ChainCommunicationError::CustomError(format!("{e:?}")))?;

    Ok(res.0)
}
