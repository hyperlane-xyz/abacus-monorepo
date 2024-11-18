use std::fmt::Debug;

use async_trait::async_trait;
use serde::{de::DeserializeOwned, Serialize};

use hyperlane_core::H256;

use crate::cache::{CacheError, FunctionCallCache};

use super::{BaseCache, CacheResult, Expiration, ExpirationType};

/// Cache for storing function calls with serializable results
#[derive(Debug, Clone)]
pub struct HyperlaneMokaCache(BaseCache);

impl HyperlaneMokaCache {
    /// Create a new cache with the given name
    pub fn new(name: &str) -> Self {
        Self(BaseCache::new(name))
    }

    /// Set a value in the cache
    async fn set(
        &self,
        key: &impl Serialize,
        value: &impl Serialize,
        ttl: ExpirationType,
    ) -> Result<Expiration, CacheError> {
        self.0.set(key, value, ttl).await
    }

    /// Get a value from the cache
    async fn get<T: DeserializeOwned>(
        &self,
        key: &impl Serialize,
    ) -> CacheResult<Option<(T, Expiration)>> {
        self.0.get::<T>(key).await
    }

    /// Cache a call result with the given parameters
    pub async fn cache_call_result(
        &self,
        contract_address: Option<H256>,
        method: &str,
        fn_params: &impl Serialize,
        result: &impl Serialize,
    ) -> CacheResult<Expiration> {
        let key = (contract_address, method, fn_params);
        self.set(&key, result, ExpirationType::Default).await
    }

    /// Get a cached call result with the given parameters
    pub async fn get_cached_call_result<T: DeserializeOwned>(
        &self,
        contract_address: Option<H256>,
        method: &str,
        fn_params: &impl Serialize,
    ) -> CacheResult<Option<T>> {
        let key = (contract_address, method, fn_params);
        let value = self.get::<T>(&key).await?;

        match value {
            Some((value, _)) => Ok(Some(value)),
            None => Ok(None),
        }
    }
}

#[async_trait]
impl FunctionCallCache for HyperlaneMokaCache {
    async fn cache_call_result(
        &self,
        contract_address: Option<H256>,
        method: &str,
        fn_params: &(impl Serialize + Send + Sync),
        result: &(impl Serialize + Send + Sync),
    ) -> CacheResult<Expiration> {
        self.cache_call_result(contract_address, method, fn_params, result)
            .await
    }

    /// Get a cached call result with the given parameters
    async fn get_cached_call_result<T>(
        &self,
        contract_address: Option<H256>,
        method: &str,
        fn_params: &(impl Serialize + Send + Sync),
    ) -> CacheResult<Option<T>>
    where
        T: DeserializeOwned,
    {
        self.get_cached_call_result(contract_address, method, fn_params)
            .await
    }
}
