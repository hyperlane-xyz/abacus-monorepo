use crate::{ConnectionConf, Signer, SovereignProvider};
use async_trait::async_trait;
use hyperlane_core::{
    ChainResult, ContractLocator, HyperlaneChain, HyperlaneContract, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, InterchainSecurityModule, ModuleType, H256, U256,
};

/// A struct for the ISM on the Sovereign chain.
#[derive(Debug)]
pub struct SovereignInterchainSecurityModule {
    domain: HyperlaneDomain,
    address: H256,
    provider: SovereignProvider,
}

impl SovereignInterchainSecurityModule {
    /// Create a new `SovereignInterchainSecurityModule`.
    pub async fn new(
        conf: &ConnectionConf,
        locator: ContractLocator<'_>,
        signer: Option<Signer>,
    ) -> ChainResult<Self> {
        let provider =
            SovereignProvider::new(locator.domain.clone(), &conf.clone(), signer).await?;
        Ok(SovereignInterchainSecurityModule {
            domain: locator.domain.clone(),
            provider,
            address: locator.address,
        })
    }
}

impl HyperlaneContract for SovereignInterchainSecurityModule {
    fn address(&self) -> H256 {
        self.address
    }
}

impl HyperlaneChain for SovereignInterchainSecurityModule {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.provider.clone())
    }
}

#[async_trait]
impl InterchainSecurityModule for SovereignInterchainSecurityModule {
    async fn dry_run_verify(
        &self,
        _message: &HyperlaneMessage,
        _metadata: &[u8],
    ) -> ChainResult<Option<U256>> {
        let result = self.provider.client().dry_run().await?;

        Ok(result)
    }

    async fn module_type(&self) -> ChainResult<ModuleType> {
        let module_type = self.provider.client().module_type(self.address).await?;

        Ok(module_type)
    }
}
