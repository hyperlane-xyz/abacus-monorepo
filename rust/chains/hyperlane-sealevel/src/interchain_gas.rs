use async_trait::async_trait;
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract,
    HyperlaneDomain, HyperlaneProvider, IndexRange, Indexer, InterchainGasPaymaster,
    InterchainGasPayment, LogMeta, H256,
};
use tracing::{info, instrument};

use crate::{
    solana::{
        commitment_config::CommitmentConfig,
        pubkey::Pubkey, /*, nonblocking_rpc_client::RpcClient*/
    },
    ConnectionConf, SealevelProvider,
};

use crate::RpcClientWithDebug;

/// A reference to an IGP contract on some Sealevel chain
#[derive(Debug)]
pub struct SealevelInterchainGasPaymaster {
    program_id: Pubkey,
    // rpc_client: crate::RpcClientWithDebug, // FIXME we don't need a client here?
    domain: HyperlaneDomain,
}

impl SealevelInterchainGasPaymaster {
    pub fn new(_conf: &ConnectionConf /*TODO don't need?*/, locator: ContractLocator) -> Self {
        let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));
        // let rpc_client = crate::RpcClientWithDebug::new(conf.url.clone());
        Self {
            program_id,
            // rpc_client,
            domain: locator.domain.clone(),
        }
    }
}

impl HyperlaneContract for SealevelInterchainGasPaymaster {
    fn address(&self) -> H256 {
        self.program_id.to_bytes().into()
    }
}

impl HyperlaneChain for SealevelInterchainGasPaymaster {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(SealevelProvider::new(self.domain.clone()))
    }
}

impl InterchainGasPaymaster for SealevelInterchainGasPaymaster {}

/// Struct that retrieves event data for a Sealevel IGP contract
#[derive(Debug)]
pub struct SealevelInterchainGasPaymasterIndexer {
    rpc_client: RpcClientWithDebug,
}

impl SealevelInterchainGasPaymasterIndexer {
    pub fn new(conf: &ConnectionConf, _locator: ContractLocator /*TODO don't need?*/) -> Self {
        // let program_id = Pubkey::from(<[u8; 32]>::from(locator.address));
        // let domain = locator.domain;
        let rpc_client = RpcClientWithDebug::new(conf.url.to_string());
        Self {
            // program_id,
            rpc_client,
            // domain,
        }
    }
}

#[async_trait]
impl Indexer<InterchainGasPayment> for SealevelInterchainGasPaymasterIndexer {
    #[instrument(err, skip(self))]
    async fn fetch_logs(
        &self,
        _range: IndexRange,
    ) -> ChainResult<Vec<(InterchainGasPayment, LogMeta)>> {
        // TODO implement this
        info!("Reporting no gas payments");
        Ok(vec![])
    }

    #[instrument(level = "debug", err, ret, skip(self))]
    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        let height = self
            .rpc_client
            .get_slot_with_commitment(CommitmentConfig::finalized())
            .await
            .map_err(ChainCommunicationError::from_other)?
            .try_into()
            // FIXME solana block height is u64...
            .expect("sealevel block height exceeds u32::MAX");
        Ok(height)
    }
}
