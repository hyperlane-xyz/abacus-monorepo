use std::{env, fmt::Debug, sync::Arc};

use async_trait::async_trait;
use eyre::Result;
use hyperlane_core::config::*;
use tokio::task::JoinHandle;
use tracing::{debug, instrument::Instrumented};

use crate::{
    create_chain_metrics,
    metrics::{create_agent_metrics, AgentMetrics, CoreMetrics},
    settings::Settings,
    ChainMetrics,
};

/// Properties shared across all hyperlane agents
#[derive(Debug)]
pub struct HyperlaneAgentCore {
    /// Prometheus metrics
    pub metrics: Arc<CoreMetrics>,
    /// Settings this agent was created with
    pub settings: Settings,
}

/// Settings of an agent defined from configuration
pub trait LoadableFromSettings: AsRef<Settings> + Sized {
    /// Create a new instance of these settings by reading the configs and env
    /// vars.
    fn load() -> ConfigResult<Self>;
}

/// A fundamental agent which does not make any assumptions about the tools
/// which are used.
#[async_trait]
pub trait BaseAgent: Send + Sync + Debug {
    /// The agent's name
    const AGENT_NAME: &'static str;

    /// The settings object for this agent
    type Settings: LoadableFromSettings;

    /// Instantiate the agent from the standard settings object
    async fn from_settings(
        settings: Self::Settings,
        metrics: Arc<CoreMetrics>,
        agent_metrics: AgentMetrics,
        chain_metrics: ChainMetrics,
    ) -> Result<Self>
    where
        Self: Sized;

    /// Start running this agent.
    #[allow(clippy::async_yields_async)]
    async fn run(self) -> Result<()>;
}

/// Call this from `main` to fully initialize and run the agent for its entire
/// lifecycle. This assumes only a single agent is being run. This will
/// initialize the metrics server and tracing as well.
pub async fn agent_main<A: BaseAgent>() -> Result<()> {
    if env::var("ONELINE_BACKTRACES")
        .map(|v| v.to_lowercase())
        .as_deref()
        == Ok("true")
    {
        #[cfg(feature = "oneline-errors")]
        crate::oneline_eyre::install()?;
        #[cfg(not(feature = "oneline-errors"))]
        panic!("The oneline errors feature was not included");
    } else {
        #[cfg(feature = "color_eyre")]
        color_eyre::install()?;
    }

    let settings = A::Settings::load()?;
    let core_settings: &Settings = settings.as_ref();

    let metrics = settings.as_ref().metrics(A::AGENT_NAME)?;
    core_settings.tracing.start_tracing(&metrics)?;
    let agent_metrics = create_agent_metrics(&metrics)?;
    let chain_metrics = create_chain_metrics(&metrics)?;
    let agent = A::from_settings(settings, metrics.clone(), agent_metrics, chain_metrics).await?;

    // This await will only end if a critical error is propagated, which we do want to crash on
    agent.run().await
}

/// Utility to run multiple tasks and shutdown if any one task ends.
#[allow(clippy::unit_arg, unused_must_use)]
pub async fn run_all(
    mut tasks: Vec<Instrumented<JoinHandle<Result<(), eyre::Report>>>>,
) -> Result<()> {
    debug_assert!(!tasks.is_empty(), "No tasks submitted");
    while !tasks.is_empty() {
        let (res, _, remaining) = futures_util::future::select_all(tasks).await;
        println!("~~~ SELECT_ALL RETURNED {:?}", res);
        match res {
            Ok(Ok(())) => {}
            // One of the tasks panicked
            Err(err) => {
                abort_tasks(remaining).await;
                return Err(err.into());
            }
            // One of the tasks returned an unrecoverable error
            Ok(Err(err)) => {
                abort_tasks(remaining).await;
                return Err(err);
            }
        }
        tasks = remaining;
    }

    Ok(())
}

pub async fn abort_tasks(mut tasks: Vec<Instrumented<JoinHandle<Result<()>>>>) {
    for task in tasks.drain(..) {
        let t = task.into_inner();
        t.abort();
        let res = t.await;
        debug!(result= ?res, "Spun down tokio task, with result")
    }
}
