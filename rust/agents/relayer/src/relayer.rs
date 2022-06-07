use async_trait::async_trait;
use eyre::{Context, Result};
use tokio::{
    sync::watch::{channel, Receiver, Sender},
    task::JoinHandle,
};
use tracing::{instrument::Instrumented, Instrument};

use abacus_base::{
    AbacusAgentCore, Agent, ContractSyncMetrics, InboxContracts, MultisigCheckpointSyncer,
};
use abacus_core::MultisigSignedCheckpoint;

use crate::settings::CompiledWhitelist;
use crate::{
    checkpoint_fetcher::CheckpointFetcher, message_processor::MessageProcessor,
    settings::RelayerSettings as Settings,
};

/// A relayer agent
#[derive(Debug)]
pub struct Relayer {
    signed_checkpoint_polling_interval: u64,
    max_processing_retries: u32,
    multisig_checkpoint_syncer: MultisigCheckpointSyncer,
    core: AbacusAgentCore,
    whitelist: Option<CompiledWhitelist>,
}

impl AsRef<AbacusAgentCore> for Relayer {
    fn as_ref(&self) -> &AbacusAgentCore {
        &self.core
    }
}

#[async_trait]
#[allow(clippy::unit_arg)]
impl Agent for Relayer {
    const AGENT_NAME: &'static str = "relayer";

    type Settings = Settings;

    async fn from_settings(settings: Self::Settings) -> Result<Self>
    where
        Self: Sized,
    {
        let multisig_checkpoint_syncer: MultisigCheckpointSyncer = settings
            .multisigcheckpointsyncer
            .try_into_multisig_checkpoint_syncer()?;
        Ok(Self {
            signed_checkpoint_polling_interval: settings
                .signedcheckpointpollinginterval
                .parse()
                .unwrap_or(5),
            max_processing_retries: settings.maxprocessingretries.parse().unwrap_or(10),
            multisig_checkpoint_syncer,
            core: settings
                .as_ref()
                .try_into_abacus_core(Self::AGENT_NAME)
                .await?,
            whitelist: settings
                .whitelist
                .map(|wl| wl.try_into().expect("Invalid whitelist configuration")),
        })
    }
}

impl Relayer {
    fn run_outbox_sync(
        &self,
        sync_metrics: ContractSyncMetrics,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let outbox = self.outbox();
        let sync = outbox.sync(self.as_ref().indexer.clone(), sync_metrics);
        sync
    }

    fn run_interchain_gas_paymaster_sync(
        &self,
        sync_metrics: ContractSyncMetrics,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let paymaster = self.interchain_gas_paymaster();
        let sync = paymaster.sync(self.as_ref().indexer.clone(), sync_metrics);
        sync
    }

    fn run_checkpoint_fetcher(
        &self,
        signed_checkpoint_sender: Sender<Option<MultisigSignedCheckpoint>>,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let checkpoint_fetcher = CheckpointFetcher::new(
            self.outbox().outbox(),
            self.signed_checkpoint_polling_interval,
            self.multisig_checkpoint_syncer.clone(),
            signed_checkpoint_sender,
            self.core.metrics.last_known_message_leaf_index(),
        );
        checkpoint_fetcher.spawn()
    }

    fn run_inbox(
        &self,
        inbox_contracts: InboxContracts,
        signed_checkpoint_receiver: Receiver<Option<MultisigSignedCheckpoint>>,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let db = self.outbox().db();
        let message_processor = MessageProcessor::new(
            self.outbox().outbox(),
            self.max_processing_retries,
            db,
            inbox_contracts,
            signed_checkpoint_receiver,
            self.core.metrics.last_known_message_leaf_index(),
            self.core.metrics.retry_queue_length(),
        );

        message_processor.spawn()
    }

    fn wrap_inbox_run(
        &self,
        inbox_name: &str,
        inbox_contracts: InboxContracts,
        signed_checkpoint_receiver: Receiver<Option<MultisigSignedCheckpoint>>,
    ) -> Instrumented<JoinHandle<Result<()>>> {
        let m = format!("Task for inbox named {} failed", inbox_name);
        let handle = self
            .run_inbox(inbox_contracts, signed_checkpoint_receiver)
            .in_current_span();
        let fut = async move { handle.await?.wrap_err(m) };

        tokio::spawn(fut).in_current_span()
    }

    pub fn run(&self) -> Instrumented<JoinHandle<Result<()>>> {
        let (signed_checkpoint_sender, signed_checkpoint_receiver) =
            channel::<Option<MultisigSignedCheckpoint>>(None);

        let mut tasks: Vec<Instrumented<JoinHandle<Result<()>>>> = self
            .inboxes()
            .iter()
            .map(|(inbox_name, inbox_contracts)| {
                self.wrap_inbox_run(
                    inbox_name,
                    inbox_contracts.clone(),
                    signed_checkpoint_receiver.clone(),
                )
            })
            .collect();

        tasks.push(self.run_checkpoint_fetcher(signed_checkpoint_sender));

        let sync_metrics = ContractSyncMetrics::new(self.metrics());
        tasks.push(self.run_outbox_sync(sync_metrics.clone()));
        tasks.push(self.run_interchain_gas_paymaster_sync(sync_metrics));
        self.run_all(tasks)
    }
}

#[cfg(test)]
mod test {}
