use async_trait::async_trait;
use tokio::task::JoinHandle;
use tracing::instrument::Instrumented;

use abacus_base::BaseAgent;

use crate::settings::ScraperSettings;

/// A message explorer scraper agent
#[derive(Debug)]
pub struct Scraper {}

#[async_trait]
impl BaseAgent for Scraper {
    const AGENT_NAME: &'static str = "scraper";
    type Settings = ScraperSettings;

    async fn from_settings(settings: Self::Settings) -> eyre::Result<Self>
    where
        Self: Sized,
    {
        todo!()
    }

    fn run(&self) -> Instrumented<JoinHandle<eyre::Result<()>>> {
        todo!()
    }
}
