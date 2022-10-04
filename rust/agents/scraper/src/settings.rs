use std::collections::HashMap;

use abacus_base::decl_settings;
use abacus_base::{ChainSetup, IndexSettings, OutboxAddresses};

// TODO: Make it so the inherited settings better communicate that the `outbox`
// config is not needed for the scraper.
decl_settings!(Scraper {
    /// Configurations for contracts on the outbox chains
    outboxes: HashMap<String, ChainSetup<OutboxAddresses>>,
    /// Index settings by chain
    indexes: HashMap<String, IndexSettings>,
});
