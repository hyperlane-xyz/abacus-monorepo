use crate::{
    indexer::SovIndexer,
    rest_client::{SovereignRestClient, TxEvent},
    ConnectionConf, Signer, SovereignProvider,
};
use async_trait::async_trait;
use core::ops::RangeInclusive;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneProvider, Indexed, Indexer, InterchainGasPaymaster, InterchainGasPayment, LogMeta,
    SequenceAwareIndexer, H256, H512,
};

/// A reference to a `InterchainGasPaymasterIndexer` contract on some Sovereign chain
#[derive(Debug, Clone)]
pub struct SovereignInterchainGasPaymasterIndexer {
    provider: Box<SovereignProvider>,
}

impl SovereignInterchainGasPaymasterIndexer {
    /// Create a new `SovereignInterchainGasPaymasterIndexer`.
    pub async fn new(conf: ConnectionConf, locator: ContractLocator<'_>) -> ChainResult<Self> {
        let provider = SovereignProvider::new(locator.domain.clone(), &conf, None).await?;

        Ok(SovereignInterchainGasPaymasterIndexer {
            provider: Box::new(provider),
        })
    }
}

#[async_trait]
impl crate::indexer::SovIndexer<InterchainGasPayment> for SovereignInterchainGasPaymasterIndexer {
    const EVENT_KEY: &'static str = "IGP/GasPayment";
    fn client(&self) -> &SovereignRestClient {
        self.provider.client()
    }
    async fn latest_sequence(&self) -> ChainResult<Option<u32>> {
        Ok(None)
    }
    fn decode_event(&self, _event: &TxEvent) -> ChainResult<InterchainGasPayment> {
        todo!()
    }
}

#[async_trait]
impl SequenceAwareIndexer<InterchainGasPayment> for SovereignInterchainGasPaymasterIndexer {
    async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
        <Self as SovIndexer<InterchainGasPayment>>::latest_sequence_count_and_tip(self).await
    }
}

#[async_trait]
impl Indexer<InterchainGasPayment> for SovereignInterchainGasPaymasterIndexer {
    async fn fetch_logs_in_range(
        &self,
        range: RangeInclusive<u32>,
    ) -> ChainResult<Vec<(Indexed<InterchainGasPayment>, LogMeta)>> {
        <Self as SovIndexer<InterchainGasPayment>>::fetch_logs_in_range(self, range).await
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        <Self as SovIndexer<InterchainGasPayment>>::get_finalized_block_number(self).await
    }

    async fn fetch_logs_by_tx_hash(
        &self,
        tx_hash: H512,
    ) -> ChainResult<Vec<(Indexed<InterchainGasPayment>, LogMeta)>> {
        <Self as SovIndexer<InterchainGasPayment>>::fetch_logs_by_tx_hash(self, tx_hash).await
    }
}

/// A struct for the Interchain Gas Paymaster on the Sovereign chain.
#[derive(Debug)]
pub struct SovereignInterchainGasPaymaster {
    domain: HyperlaneDomain,
    address: H256,
    provider: SovereignProvider,
}

impl SovereignInterchainGasPaymaster {
    /// Create a new `SovereignInterchainGasPaymaster`.
    pub async fn new(
        conf: &ConnectionConf,
        locator: ContractLocator<'_>,
        signer: Option<Signer>,
    ) -> ChainResult<Self> {
        let provider =
            SovereignProvider::new(locator.domain.clone(), &conf.clone(), signer).await?;
        Ok(SovereignInterchainGasPaymaster {
            domain: locator.domain.clone(),
            provider,
            address: locator.address,
        })
    }
}

impl HyperlaneContract for SovereignInterchainGasPaymaster {
    fn address(&self) -> H256 {
        self.address
    }
}

impl HyperlaneChain for SovereignInterchainGasPaymaster {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl InterchainGasPaymaster for SovereignInterchainGasPaymaster {}
