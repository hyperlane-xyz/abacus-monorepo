#![allow(clippy::enum_variant_names)]
#![allow(missing_docs)]

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use ethers::abi::Token;
use ethers::providers::Middleware;
use ethers::types::{Selector, H160, H256, U256};
use eyre::Result;
use tokio::sync::RwLock;
use tracing::instrument;

use hyperlane_core::accumulator::merkle::Proof;
use hyperlane_core::{
    ChainCommunicationError, ContractLocator, HyperlaneAbi, HyperlaneChain, HyperlaneContract,
    MultisigIsm, MultisigSignedCheckpoint,
};

use crate::contracts::multisig_ism::{MultisigIsm as EthereumMultisigIsmInternal, MULTISIGISM_ABI};
use crate::trait_builder::MakeableWithProvider;

#[derive(Debug)]
struct Timestamped<Value> {
    t: Instant,
    value: Value,
}

impl<Value> Timestamped<Value> {
    fn new(value: Value) -> Timestamped<Value> {
        Timestamped {
            t: Instant::now(),
            value,
        }
    }
}

#[derive(Debug)]
pub struct ExpiringCache<Key, Value>
where
    Key: Eq + Hash,
{
    expiry: Duration,                        // cache endurance
    cache: HashMap<Key, Timestamped<Value>>, // hashmap containing references to cached items
}

impl<Key, Value> ExpiringCache<Key, Value>
where
    Key: Copy + Eq + Hash + tracing::Value,
    Value: Clone,
{
    pub fn new(expiry: Duration) -> ExpiringCache<Key, Value> {
        ExpiringCache {
            expiry,
            cache: HashMap::new(),
        }
    }

    pub fn put(&mut self, key: Key, value: Value) {
        self.cache.insert(key, Timestamped::new(value));
    }

    pub fn get(&self, key: Key) -> Option<&Value> {
        if let Some(entry) = self.cache.get(&key) {
            if entry.t.elapsed() > self.expiry {
                None
            } else {
                Some(&entry.value)
            }
        } else {
            None
        }
    }
}

impl<M> std::fmt::Display for EthereumMultisigIsmInternal<M>
where
    M: Middleware,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self)
    }
}

pub struct MultisigIsmBuilder {}

#[async_trait]
impl MakeableWithProvider for MultisigIsmBuilder {
    type Output = Box<dyn MultisigIsm>;

    async fn make_with_provider<M: Middleware + 'static>(
        &self,
        provider: M,
        locator: &ContractLocator,
    ) -> Self::Output {
        Box::new(EthereumMultisigIsm::new(Arc::new(provider), locator))
    }
}

/// A reference to an MultisigIsm contract on some Ethereum chain
#[derive(Debug)]
pub struct EthereumMultisigIsm<M>
where
    M: Middleware,
{
    contract: Arc<EthereumMultisigIsmInternal<M>>,
    #[allow(dead_code)]
    domain: u32,
    chain_name: String,
    #[allow(dead_code)]
    provider: Arc<M>,
    threshold_cache: RwLock<ExpiringCache<u32, U256>>,
    validators_cache: RwLock<ExpiringCache<u32, Vec<H160>>>,
}

impl<M> EthereumMultisigIsm<M>
where
    M: Middleware + 'static,
{
    /// Create a reference to a mailbox at a specific Ethereum address on some
    /// chain
    pub fn new(provider: Arc<M>, locator: &ContractLocator) -> Self {
        Self {
            contract: Arc::new(EthereumMultisigIsmInternal::new(
                &locator.address,
                provider.clone(),
            )),
            domain: locator.domain,
            chain_name: locator.chain_name.to_owned(),
            provider,
            threshold_cache: RwLock::new(ExpiringCache::new(Duration::from_secs(60))),
            validators_cache: RwLock::new(ExpiringCache::new(Duration::from_secs(60))),
        }
    }
}

impl<M> HyperlaneChain for EthereumMultisigIsm<M>
where
    M: Middleware + 'static,
{
    fn chain_name(&self) -> &str {
        &self.chain_name
    }

    fn domain(&self) -> u32 {
        self.domain
    }
}

impl<M> HyperlaneContract for EthereumMultisigIsm<M>
where
    M: Middleware + 'static,
{
    fn address(&self) -> H256 {
        self.contract.address().into()
    }
}

#[async_trait]
impl<M> MultisigIsm for EthereumMultisigIsm<M>
where
    M: Middleware + 'static,
{
    /// Returns the metadata needed by the contract's verify function
    async fn format_metadata(
        &self,
        checkpoint: &MultisigSignedCheckpoint,
        proof: Proof,
    ) -> Result<Vec<u8>, ChainCommunicationError> {
        let threshold = self.threshold(checkpoint.checkpoint.mailbox_domain).await?;
        let validators: Vec<H256> = self
            .validators(checkpoint.checkpoint.mailbox_domain)
            .await?
            .iter()
            .map(|&x| H256::from(x))
            .collect();
        let validator_tokens: Vec<Token> = validators
            .iter()
            .map(|x| Token::FixedBytes(x.to_fixed_bytes().into()))
            .collect();
        let proof_tokens: Vec<Token> = proof
            .path
            .iter()
            .map(|x| Token::FixedBytes(x.to_fixed_bytes().into()))
            .collect();
        let prefix = ethers::abi::encode(&[
            Token::FixedBytes(checkpoint.checkpoint.root.to_fixed_bytes().into()),
            Token::Uint(U256::from(checkpoint.checkpoint.index)),
            Token::FixedBytes(
                checkpoint
                    .checkpoint
                    .mailbox_address
                    .to_fixed_bytes()
                    .into(),
            ),
            Token::FixedArray(proof_tokens),
            Token::Uint(threshold),
        ]);
        let suffix = ethers::abi::encode(&[Token::FixedArray(validator_tokens)]);
        // The ethers encoder likes to zero-pad non word-aligned byte arrays.
        // Thus, we pack the signatures, which are not word-aligned, ourselves.
        let signature_vecs: Vec<Vec<u8>> =
            checkpoint.signatures.iter().map(|x| x.to_vec()).collect();
        let signature_bytes = signature_vecs.concat();
        let metadata = [prefix, signature_bytes, suffix].concat();
        Ok(metadata)
    }

    #[instrument(err, ret, skip(self))]
    async fn threshold(&self, domain: u32) -> Result<U256, ChainCommunicationError> {
        let entry = self.threshold_cache.read().await.get(domain).cloned();
        if let Some(threshold) = entry {
            Ok(threshold)
        } else {
            let threshold = self.contract.threshold(domain).call().await?;
            self.threshold_cache.write().await.put(domain, threshold);
            Ok(threshold)
        }
    }

    #[instrument(err, ret, skip(self))]
    async fn validators(&self, domain: u32) -> Result<Vec<H160>, ChainCommunicationError> {
        let entry = self.validators_cache.read().await.get(domain).cloned();
        if let Some(validators) = entry {
            Ok(validators)
        } else {
            let validators = self.contract.validators(domain).call().await?;
            self.validators_cache
                .write()
                .await
                .put(domain, validators.clone());
            Ok(validators)
        }
    }
}

pub struct EthereumMultisigIsmAbi;

impl HyperlaneAbi for EthereumMultisigIsmAbi {
    fn fn_map() -> HashMap<Selector, &'static str> {
        super::extract_fn_map(&MULTISIGISM_ABI)
    }
}
