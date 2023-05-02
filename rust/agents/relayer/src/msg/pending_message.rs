use std::cmp::Ordering;
use std::fmt::{Debug, Formatter};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use derive_new::new;
use eyre::{Report, Result};
use prometheus::IntCounter;
use tracing::{debug, error, info, instrument};
use hyperlane_base::CachingMailbox;

use hyperlane_core::{HyperlaneMessage, U256};
use crate::msg::gas_payment::GasPaymentEnforcer;
use crate::msg::metadata::BaseMetadataBuilder;

/// The message context contains the links needed to submit a message. Each instance is for a
/// unique origin -> destination pairing.
struct MessageCtx {
    /// Mailbox on the destination chain.
    mailbox: CachingMailbox,
    /// Used to construct the ISM metadata needed to verify a message from the origin.
    metadata_builder: BaseMetadataBuilder,
    /// Used to determine if messages from the origin have made sufficient gas payments.
    gas_payment_enforcer: Arc<GasPaymentEnforcer>,
    /// Hard limit on transaction gas when submitting a transaction to the destination.
    transaction_gas_limit: Option<U256>,
}

/// A message that the submitter can and should try to submit.
#[derive(Clone, new)]
pub(crate) struct PendingMessage {
    pub message: HyperlaneMessage,
    ctx: Arc<MessageCtx>,
    #[new(default)]
    state: Option<Box<PendingMessageState>>,
    #[new(default)]
    num_retries: u32,
    #[new(value = "Instant::now()")]
    last_attempted_at: Instant,
    #[new(default)]
    next_attempt_after: Option<Instant>,
}

/// State for the next submission attempt generated by a prepare call.
struct PendingMessageState {}

impl Debug for PendingMessage {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        // intentionally leaves out ctx
        let now = Instant::now();
        let last_attempt = now.duration_since(self.last_attempted_at).as_secs();
        let next_attempt = self
            .next_attempt_after
            .map(|a| {
                if a >= now {
                    a.duration_since(now).as_secs()
                } else {
                    0
                }
            })
            .unwrap_or(0);
        write!(f, "PendingMessage {{ num_retires: {}, since_last_attempt_s: {last_attempt}, next_attempt_after_s: {next_attempt}, message: {:?} }}",
               self.num_retries, self.message)
    }
}

/// Sort by their next allowed attempt time and if no allowed time is set, then
/// put it in front of those with a time (they have been tried before) and break
/// ties between ones that have not been tried with the nonce.
impl Ord for PendingMessage {
    fn cmp(&self, other: &Self) -> Ordering {
        use Ordering::*;
        match (&self.next_attempt_after, &other.next_attempt_after) {
            (Some(s), Some(o)) => s.cmp(o),
            (Some(_), None) => Greater,
            (None, Some(_)) => Less,
            (None, None) => self.message.nonce.cmp(&other.message.nonce),
        }
    }
}

impl PartialOrd for PendingMessage {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl PartialEq for PendingMessage {
    fn eq(&self, other: &Self) -> bool {
        self.num_retries == other.num_retries && self.message.nonce == other.message.nonce
    }
}

impl Eq for PendingMessage {}

#[async_trait]
impl PendingOperation for PendingMessage {
    async fn submit(&mut self) -> TxRunResult {

        match self.processe().await {
            Ok(true) => {
                info!(msg=%self.message, "Message processed");
                self.record_message_process_success(&)?;
                return TxRunResult::Success;
            }
            Ok(false) => {
                info!(msg=%msg.message, "Message not processed");
            }
            // We expect this branch to be hit when there is unexpected behavior -
            // defined behavior like gas estimation failing will not hit this branch.
            Err(error) => {
                error!(msg=%msg.message, ?error, "Error occurred when attempting to process message");
            }
        }

        self.num_retries += 1;
        self.last_attempted_at = Instant::now();
        self.next_attempt_after = PendingMessage::calculate_msg_backoff(self.num_retries)
            .map(|dur| self.last_attempted_at + dur);
        TxRunResult::Retry
    }

    fn next_attempt_after(&self) -> Option<Instant> {
        self.next_attempt_after
    }
}

impl PendingMessage {
    /// Returns the message's status. If the message is processed, either by a
    /// transaction in this fn or by a view call to the Mailbox contract
    /// discovering the message has already been processed, Ok(true) is
    /// returned. If this message is unable to be processed, either due to
    /// failed gas estimation or an insufficient gas payment, Ok(false) is
    /// returned.
    #[instrument]
    async fn process(&mut self) -> Result<bool> {
        // If the message has already been processed, e.g. due to another relayer having
        // already processed, then mark it as already-processed, and move on to
        // the next tick.
        //
        // TODO(webbhorn): Make this robust to re-orgs on mailbox.
        if self.ctx.mailbox.delivered(msg.message.id()).await? {
            debug!("Message already processed");
            return Ok(true);
        }

        // The Mailbox's `recipientIsm` function will revert if
        // the recipient is not a contract. This can pose issues with
        // our use of the RetryingProvider, which will continuously retry
        // the eth_call to the `recipientIsm` function.
        // As a workaround, we avoid the call entirely if the recipient is
        // not a contract.
        const CTX: &str = "When fetching ISM";
        let provider = self.mailbox.provider();
        if !provider
            .is_contract(&msg.message.recipient)
            .await
            .context(CTX)?
        {
            info!(
                recipient=?msg.message.recipient,
                "Could not fetch metadata: Recipient is not a contract"
            );
            return Ok(false);
        }

        let ism_address = self
            .mailbox
            .recipient_ism(msg.message.recipient)
            .await
            .context(CTX)?;

        let Some(metadata) = self.metadata_builder
            .build(ism_address, &msg.message)
            .await?
            else {
                info!("Could not fetch metadata");
                return Ok(false)
            };

        // Estimate transaction costs for the process call. If there are issues, it's
        // likely that gas estimation has failed because the message is
        // reverting. This is defined behavior, so we just log the error and
        // move onto the next tick.
        let tx_cost_estimate = match self
            .mailbox
            .process_estimate_costs(&msg.message, &metadata)
            .await
        {
            Ok(tx_cost_estimate) => tx_cost_estimate,
            Err(error) => {
                info!(?error, "Error estimating process costs");
                return Ok(false);
            }
        };

        // If the gas payment requirement hasn't been met, move to the next tick.
        let Some(gas_limit) = self
            .gas_payment_enforcer
            .message_meets_gas_payment_requirement(&msg.message, &tx_cost_estimate)
            .await?
            else {
                info!(?tx_cost_estimate, "Gas payment requirement not met yet");
                return Ok(false);
            };

        // Go ahead and attempt processing of message to destination chain.
        debug!(?gas_limit, "Ready to process message");

        // TODO: consider differentiating types of processing errors, and pushing to the
        //  front of the run queue for intermittent types of errors that can
        //  occur even if a message's processing isn't reverting, e.g. timeouts
        //  or txs being dropped from the mempool. To avoid consistently retrying
        //  only these messages, the number of retries could be considered.

        let gas_limit = tx_cost_estimate.gas_limit;

        if let Some(max_limit) = self.transaction_gas_limit {
            if gas_limit > max_limit {
                info!("Message delivery estimated gas exceeds max gas limit");
                return Ok(false);
            }
        }

        // We use the estimated gas limit from the prior call to
        // `process_estimate_costs` to avoid a second gas estimation.
        let outcome = self
            .mailbox
            .process(&msg.message, &metadata, Some(gas_limit))
            .await?;

        // TODO(trevor): Instead of immediately marking as processed, move to a
        //  verification queue, which will wait for finality and indexing by the
        //  mailbox indexer and then mark as processed (or eventually retry if
        //  no confirmation is ever seen).

        self.gas_payment_enforcer
            .record_tx_outcome(&msg.message, outcome)?;
        if outcome.executed {
            info!(
                hash=?outcome.txid,
                rq_sz=?self.run_queue.len(),
                "Message successfully processed by transaction"
            );
            Ok(true)
        } else {
            info!(
                hash=?outcome.txid,
                "Transaction attempting to process transaction reverted"
            );
            Ok(false)
        }
    }

    /// Record in HyperlaneDB and various metrics that this process has observed
    /// the successful processing of a message. An `Ok(())` value returned by
    /// this function is the 'commit' point in a message's lifetime for
    /// final processing -- after this function has been seen to
    /// `return Ok(())`, then without a wiped HyperlaneDB, we will never
    /// re-attempt processing for this message again, even after the relayer
    /// restarts.
    fn record_message_process_success(&mut self, msg: &PendingMessage) -> Result<()> {
        self.ctx.db.mark_nonce_as_processed(msg.message.nonce)?;
        self.ctx.metrics.max_submitted_nonce =
            std::cmp::max(self.metrics.max_submitted_nonce, msg.message.nonce);
        self.metrics
            .processed_gauge
            .set(self.metrics.max_submitted_nonce as i64);
        self.metrics.messages_processed_count.inc();
        Ok(())
    }

    /// Get duration we should wait before re-attempting to deliver a message
    /// given the number of retries.
    fn calculate_msg_backoff(num_retries: u32) -> Option<Duration> {
        Some(Duration::from_secs(match num_retries {
            i if i < 1 => return None,
            // wait 10s for the first few attempts; this prevents thrashing
            i if (1..12).contains(&i) => 10,
            // wait 90s to 19.5min with a linear increase
            i if (12..24).contains(&i) => (i as u64 - 11) * 90,
            // exponential increase + 30 min; -21 makes it so that at i = 32 it will be
            // ~60min timeout (64min to be more precise).
            i => (2u64).pow(i - 21) + 60 * 30,
        }))
    }
}

#[derive(Debug)]
pub(crate) struct MessageSubmissionMetrics {
    processed_gauge: IntGauge,
    processed_count: IntCounter,
    processed_prepare_time: IntCounter,
    processed_submission_time: IntCounter,

    /// Private state used to update actual metrics each tick.
    max_submitted_nonce: u32,
}

impl SerialSubmitterMetrics {
    pub fn new(
        metrics: &CoreMetrics,
        origin: &HyperlaneDomain,
        destination: &HyperlaneDomain,
    ) -> Self {
        let origin = origin.name();
        let destination = destination.name();
        Self {
            run_queue_length_gauge: metrics.submitter_queue_length().with_label_values(&[
                origin,
                destination,
                "run_queue",
            ]),
            processed_gauge: metrics.last_known_message_nonce().with_label_values(&[
                "message_processed",
                origin,
                destination,
            ]),
            max_submitted_nonce: 0,
        }
    }
}
