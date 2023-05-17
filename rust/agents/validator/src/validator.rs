use std::time::Duration;
use std::{num::NonZeroU64, sync::Arc};

use async_trait::async_trait;
use eyre::Result;
use tokio::task::JoinHandle;
use tracing::instrument::Instrumented;

use hyperlane_base::{
    db::DB, run_all, BaseAgent, CachingMailbox, CheckpointSyncer, ContractSyncMetrics, CoreMetrics,
    HyperlaneAgentCore,
};
use hyperlane_core::{HyperlaneDomain, HyperlaneSigner, Mailbox, ValidatorAnnounce};

use crate::{
    settings::ValidatorSettings, submit::ValidatorSubmitter, submit::ValidatorSubmitterMetrics,
};

/// A validator agent
#[derive(Debug)]
pub struct Validator {
    origin_chain: HyperlaneDomain,
    core: HyperlaneAgentCore,
    mailbox: CachingMailbox,
    validator_announce: Arc<dyn ValidatorAnnounce>,
    signer: Arc<dyn HyperlaneSigner>,
    reorg_period: u64,
    interval: Duration,
    checkpoint_syncer: Arc<dyn CheckpointSyncer>,
}

impl AsRef<HyperlaneAgentCore> for Validator {
    fn as_ref(&self) -> &HyperlaneAgentCore {
        &self.core
    }
}

#[async_trait]
impl BaseAgent for Validator {
    const AGENT_NAME: &'static str = "validator";

    type Settings = ValidatorSettings;

    async fn from_settings(settings: Self::Settings, metrics: Arc<CoreMetrics>) -> Result<Self>
    where
        Self: Sized,
    {
        let db = DB::from_path(&settings.db)?;

        let signer = settings
            .validator
            // Intentionally using hyperlane_ethereum for the validator's signer
            .build::<hyperlane_ethereum::Signers>()
            .await
            .map(|validator| Arc::new(validator) as Arc<dyn HyperlaneSigner>)?;
        let core = settings.build_hyperlane_core(metrics.clone());
        let checkpoint_syncer = settings.checkpoint_syncer.build(None)?.into();

        let mailbox = settings
            .build_caching_mailbox(&settings.origin_chain, db, &metrics)
            .await?;

        let validator_announce = settings
            .build_validator_announce(&settings.origin_chain, &metrics)
            .await?;

        Ok(Self {
            origin_chain: settings.origin_chain,
            core,
            mailbox,
            validator_announce,
            signer,
            reorg_period: settings.reorg_period,
            interval: settings.interval,
            checkpoint_syncer,
        })
    }

    #[allow(clippy::async_yields_async)]
    async fn run(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let submit = ValidatorSubmitter::new(
            self.interval,
            self.reorg_period,
            self.mailbox.clone(),
            self.validator_announce.clone(),
            self.signer.clone(),
            self.checkpoint_syncer.clone(),
            ValidatorSubmitterMetrics::new(&self.core.metrics, &self.origin_chain),
        );

        // hack to start indexing messages forward from the latest nonce
        let count = self
            .mailbox
            .count(NonZeroU64::new(self.reorg_period))
            .await
            .unwrap_or(0);
        if count > 0 {
            self.mailbox.db().update_latest_nonce(count - 1).unwrap();
        }
        let sync = self.mailbox.sync(
            self.as_ref().settings.chains[self.origin_chain.name()]
                .index
                .clone(),
            ContractSyncMetrics::new(self.core.metrics.clone()),
        );

        run_all(vec![sync, submit.clone().spawn_legacy(), submit.spawn()])
    }
}

#[cfg(test)]
mod test {}
