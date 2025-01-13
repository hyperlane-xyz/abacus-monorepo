#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::providers::Middleware;
use tracing::instrument;

use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneAbi, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, RawHyperlaneMessage, RoutingIsm, H256,
};

use crate::interfaces::i_routing_ism::{
    IRoutingIsm as EthereumRoutingIsmInternal, IROUTINGISM_ABI,
};
use crate::{BuildableWithProvider, ConnectionConf, EthereumProvider};

pub struct RoutingIsmBuilder {}

#[async_trait]
impl BuildableWithProvider for RoutingIsmBuilder {
    type Output = Box<dyn RoutingIsm>;
    const NEEDS_SIGNER: bool = false;

    async fn build_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        _conn: &ConnectionConf,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumRoutingIsm::new(Arc::new(provider), locator))
    }
}

/// A reference to an RoutingIsm contract on some Ethereum chain
#[derive(Debug)]
pub struct EthereumRoutingIsm<M>
where
    M: Middleware,
{
    contract: Arc<EthereumRoutingIsmInternal<M>>,
    domain: HyperlaneDomain,
}

impl<M> EthereumRoutingIsm<M>
where
    M: Middleware + 'static,
{
    /// Create a reference to a mailbox at a specific Ethereum address on some
    /// chain
    pub fn new(provider: Arc<M>, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(EthereumRoutingIsmInternal::new(locator.address, provider)),
            domain: locator.domain.clone(),
        }
    }
}

impl<M> HyperlaneChain for EthereumRoutingIsm<M>
where
    M: Middleware + 'static,
{
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(EthereumProvider::new(
            self.contract.client(),
            self.domain.clone(),
        ))
    }
}

impl<M> HyperlaneContract for EthereumRoutingIsm<M>
where
    M: Middleware + 'static,
{
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl<M> RoutingIsm for EthereumRoutingIsm<M>
where
    M: Middleware + 'static,
{
    #[instrument(err, skip(self, message))]
    #[allow(clippy::blocks_in_conditions)] // TODO: `rustc` 1.80.1 clippy issue
    async fn route(&self, message: &HyperlaneMessage) -> ChainResult<H256> {
        let ism = self
            .contract
            .route(RawHyperlaneMessage::from(message).to_vec().into())
            .call()
            .await?;
        Ok(ism.into())
    }
}

pub struct EthereumRoutingIsmAbi;

impl HyperlaneAbi for EthereumRoutingIsmAbi {
    const SELECTOR_SIZE_BYTES: usize = 4;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        crate::extract_fn_map(&IROUTINGISM_ABI)
    }
}
