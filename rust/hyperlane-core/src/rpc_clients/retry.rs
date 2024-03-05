use futures::Future;
use std::{pin::Pin, time::Duration};
use tokio::time::sleep;
use tracing::{debug, instrument};

use crate::{ChainCommunicationError, ChainResult};

/// Max number of times to retry a call for
pub const DEFAULT_MAX_RPC_RETRIES: usize = 10;

/// Duration to sleep between retries
pub const RPC_RETRY_SLEEP_DURATION: Duration = Duration::from_secs(2);

// TODO: Refactor this function into a retrying provider. Once the watermark cursor is refactored, retrying should no longer
// be required here if the error is propagated.
/// Retry calling a fallible async function a certain number of times, with a delay between each retry
#[instrument(err, skip(f))]
pub async fn call_and_retry_n_times<T>(
    mut f: impl FnMut() -> Pin<Box<dyn Future<Output = ChainResult<T>> + Send>>,
    n: usize,
) -> ChainResult<T> {
    for retry_number in 1..n {
        match f().await {
            Ok(res) => return Ok(res),
            Err(err) => {
                debug!(retries=retry_number, error=?err, "Retrying call");
                sleep(RPC_RETRY_SLEEP_DURATION).await;
            }
        }
    }

    // TODO: Return the last error, or a vec of all the error instead of this string error
    Err(ChainCommunicationError::CustomError(
        "Retrying call failed".to_string(),
    ))
}

/// Retry calling a fallible async function a predefined number of times
#[instrument(err, skip(f))]
pub async fn call_with_retry<T>(
    f: impl FnMut() -> Pin<Box<dyn Future<Output = ChainResult<T>> + Send>>,
) -> ChainResult<T> {
    call_and_retry_n_times(f, DEFAULT_MAX_RPC_RETRIES).await
}

/// Retry calling a fallible async function indefinitely, until it succeeds
pub async fn call_and_retry_indefinitely<T>(
    f: impl FnMut() -> Pin<Box<dyn Future<Output = ChainResult<T>> + Send>>,
) -> T {
    // It's ok to unwrap, because `usize::MAX * RPC_RETRY_SLEEP_DURATION` means billions of years worth of retrying
    call_and_retry_n_times(f, usize::MAX).await.unwrap()
}
