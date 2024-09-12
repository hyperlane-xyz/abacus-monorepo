use std::fmt::Debug;

use async_trait::async_trait;
use auto_impl::auto_impl;

use crate::{ChainResult, HyperlaneContract, HyperlaneMessage, H256};

/// Interface for the MultisigIsm chain contract. Allows abstraction over
/// different chains
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait MultisigIsm: HyperlaneContract + Send + Sync + Debug {
    /// Returns the validator and threshold needed to verify message
    async fn validators_and_threshold(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<H256>, u8)>;
}

/// Interface for the WeightedMultisigIsm chain contract. Allows abstraction over
/// different chains
#[async_trait]
#[auto_impl(&, Box, Arc)]
pub trait WeightedMultisigIsm: HyperlaneContract + Send + Sync + Debug {
    /// Returns the validator and threshold needed to verify message
    async fn validators_and_threshold_weight(
        &self,
        message: &HyperlaneMessage,
    ) -> ChainResult<(Vec<(H256, u128)>, u128)>;
}
