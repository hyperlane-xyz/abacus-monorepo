use std::fmt::Debug;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use ethers::prelude::{Middleware, H256};
use eyre::eyre;
use tokio::time::sleep;
use tracing::instrument;

use hyperlane_core::{
    BlockInfo, ContractLocator, HyperlaneChain, HyperlaneProvider, TxnInfo, TxnReceiptInfo,
};

use crate::MakeableWithProvider;

/// Connection to an ethereum provider. Useful for querying information about
/// the blockchain.
#[derive(Debug, Clone)]
pub struct EthereumProvider<M>
where
    M: Middleware,
{
    provider: Arc<M>,
    chain_name: String,
    domain: u32,
}

impl<M> HyperlaneChain for EthereumProvider<M>
where
    M: Middleware + 'static,
{
    fn chain_name(&self) -> &str {
        &self.chain_name
    }

    fn domain(&self) -> u32 {
        self.domain
    }
}

#[async_trait]
impl<M> HyperlaneProvider for EthereumProvider<M>
where
    M: Middleware + 'static,
{
    #[instrument(err, skip(self))]
    async fn get_block_by_hash(&self, hash: &H256) -> eyre::Result<BlockInfo> {
        let block = get_with_retry_on_none(|| self.provider.get_block(*hash)).await?;
        Ok(BlockInfo {
            hash: *hash,
            timestamp: block.timestamp.as_u64(),
            number: block
                .number
                .ok_or_else(|| eyre!("Block is not part of the chain yet {}", hash))?
                .as_u64(),
        })
    }

    #[instrument(err, skip(self))]
    async fn get_txn_by_hash(&self, hash: &H256) -> eyre::Result<TxnInfo> {
        let txn = get_with_retry_on_none(|| self.provider.get_transaction(*hash)).await?;
        let receipt = self
            .provider
            .get_transaction_receipt(*hash)
            .await?
            .map(|r| -> eyre::Result<_> {
                Ok(TxnReceiptInfo {
                    gas_used: r
                        .gas_used
                        .ok_or_else(|| eyre!("Provider did not return gas used"))?,
                    cumulative_gas_used: r.cumulative_gas_used,
                    effective_gas_price: r.effective_gas_price,
                })
            })
            .transpose()?;

        Ok(TxnInfo {
            hash: *hash,
            max_fee_per_gas: txn.max_fee_per_gas,
            max_priority_fee_per_gas: txn.max_priority_fee_per_gas,
            gas_price: txn.gas_price,
            gas_limit: txn.gas,
            nonce: txn.nonce.as_u64(),
            sender: txn.from.into(),
            recipient: txn.to.map(Into::into),
            receipt,
        })
    }
}

/// Builder for hyperlane providers.
pub struct HyperlaneProviderBuilder {}

#[async_trait]
impl MakeableWithProvider for HyperlaneProviderBuilder {
    type Output = Box<dyn HyperlaneProvider>;

    async fn make_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumProvider {
            provider: Arc::new(provider),
            chain_name: locator.chain_name.clone(),
            domain: locator.domain,
        })
    }
}

/// Call a get function that returns a Result<Option<T>> and retry if the inner
/// option is None. This can happen because the provider has not discovered the
/// object we are looking for yet.
async fn get_with_retry_on_none<T, F, O, E>(get: F) -> eyre::Result<T>
where
    F: Fn() -> O,
    O: Future<Output = Result<Option<T>, E>>,
    E: std::error::Error + Send + Sync + 'static,
{
    for _ in 0..3 {
        if let Some(t) = get().await? {
            return Ok(t);
        } else {
            sleep(Duration::from_secs(5)).await;
            continue;
        };
    }
    Err(eyre!("Could not find object from provider"))
}
