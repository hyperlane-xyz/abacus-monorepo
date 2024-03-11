use std::{
    fmt::{Debug, Formatter},
    sync::Arc,
    time::{Duration, Instant},
};

use async_trait::async_trait;
use derive_new::new;
use eyre::Result;
use hyperlane_base::{db::HyperlaneRocksDB, CoreMetrics};
use hyperlane_core::{HyperlaneChain, HyperlaneDomain, HyperlaneMessage, Mailbox, U256};
use prometheus::{IntCounter, IntGauge};
use tracing::{debug, error, info, instrument, trace, warn};

use super::{
    gas_payment::GasPaymentEnforcer,
    metadata::{
        AppContextClassifier, BaseMetadataBuilder, MessageMetadataBuilder, MetadataBuilder,
    },
    pending_operation::*,
};

const CONFIRM_DELAY: Duration = if cfg!(any(test, feature = "test-utils")) {
    // Wait 5 seconds after submitting the message before confirming in test mode
    Duration::from_secs(5)
} else {
    // Wait 10 min after submitting the message before confirming in normal/production mode
    Duration::from_secs(60 * 10)
};

/// The message context contains the links needed to submit a message. Each
/// instance is for a unique origin -> destination pairing.
pub struct MessageContext {
    /// Mailbox on the destination chain.
    pub destination_mailbox: Arc<dyn Mailbox>,
    /// Origin chain database to verify gas payments.
    pub origin_db: HyperlaneRocksDB,
    /// Used to construct the ISM metadata needed to verify a message from the
    /// origin.
    pub metadata_builder: Arc<BaseMetadataBuilder>,
    /// Used to determine if messages from the origin have made sufficient gas
    /// payments.
    pub origin_gas_payment_enforcer: Arc<GasPaymentEnforcer>,
    /// Hard limit on transaction gas when submitting a transaction to the
    /// destination.
    pub transaction_gas_limit: Option<U256>,
    pub metrics: MessageSubmissionMetrics,
}

/// A message that the submitter can and should try to submit.
#[derive(new)]
pub struct PendingMessage {
    pub message: HyperlaneMessage,
    ctx: Arc<MessageContext>,
    app_context: Option<String>,
    #[new(default)]
    submitted: bool,
    #[new(default)]
    submission_data: Option<Box<SubmissionData>>,
    #[new(default)]
    num_retries: u32,
    #[new(value = "Instant::now()")]
    last_attempted_at: Instant,
    #[new(default)]
    next_attempt_after: Option<Instant>,
}

/// State for the next submission attempt generated by a prepare call.
struct SubmissionData {
    metadata: Vec<u8>,
    gas_limit: U256,
}

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
        write!(f, "PendingMessage {{ num_retries: {}, since_last_attempt_s: {last_attempt}, next_attempt_after_s: {next_attempt}, message: {:?} }}",
               self.num_retries, self.message)
    }
}

impl PartialEq for PendingMessage {
    fn eq(&self, other: &Self) -> bool {
        self.num_retries == other.num_retries
            && self.message.nonce == other.message.nonce
            && self.message.origin == other.message.origin
    }
}

impl Eq for PendingMessage {}

#[async_trait]
impl PendingOperation for PendingMessage {
    fn domain(&self) -> &HyperlaneDomain {
        self.ctx.destination_mailbox.domain()
    }

    #[instrument]
    async fn prepare(&mut self) -> PendingOperationResult {
        make_op_try!(|| self.on_reprepare());

        if !self.is_ready() {
            trace!("Message is not ready to be submitted yet");
            return PendingOperationResult::NotReady;
        }

        // If the message has already been processed, e.g. due to another relayer having
        // already processed, then mark it as already-processed, and move on to
        // the next tick.
        let is_already_delivered = op_try!(
            self.ctx
                .destination_mailbox
                .delivered(self.message.id())
                .await,
            "checking message delivery status"
        );
        if is_already_delivered {
            debug!("Message has already been delivered, marking as submitted.");
            self.submitted = true;
            self.next_attempt_after = Some(Instant::now() + CONFIRM_DELAY);
            return PendingOperationResult::Success;
        }

        let provider = self.ctx.destination_mailbox.provider();

        // We cannot deliver to an address that is not a contract so check and drop if it isn't.
        let is_contract = op_try!(
            provider.is_contract(&self.message.recipient).await,
            "checking if message recipient is a contract"
        );
        if !is_contract {
            info!(
                recipient=?self.message.recipient,
                "Dropping message because recipient is not a contract"
            );
            return PendingOperationResult::Drop;
        }

        let ism_address = op_try!(
            self.ctx
                .destination_mailbox
                .recipient_ism(self.message.recipient)
                .await,
            "fetching ISM address. Potentially malformed recipient ISM address."
        );

        let message_metadata_builder = op_try!(
            MessageMetadataBuilder::new(
                ism_address,
                &self.message,
                self.ctx.metadata_builder.clone()
            )
            .await,
            "getting the message metadata builder"
        );

        let Some(metadata) = op_try!(
            message_metadata_builder
                .build(ism_address, &self.message)
                .await,
            "building metadata"
        ) else {
            info!("Could not fetch metadata");
            return self.on_reprepare();
        };

        // Estimate transaction costs for the process call. If there are issues, it's
        // likely that gas estimation has failed because the message is
        // reverting. This is defined behavior, so we just log the error and
        // move onto the next tick.
        let tx_cost_estimate = op_try!(
            self.ctx
                .destination_mailbox
                .process_estimate_costs(&self.message, &metadata)
                .await,
            "estimating costs for process call"
        );

        // If the gas payment requirement hasn't been met, move to the next tick.
        let Some(gas_limit) = op_try!(
            self.ctx
                .origin_gas_payment_enforcer
                .message_meets_gas_payment_requirement(&self.message, &tx_cost_estimate)
                .await,
            "checking if message meets gas payment requirement"
        ) else {
            info!(?tx_cost_estimate, "Gas payment requirement not met yet");
            return self.on_reprepare();
        };

        // Go ahead and attempt processing of message to destination chain.
        debug!(
            ?gas_limit,
            "Gas payment requirement met, ready to process message"
        );

        let gas_limit = tx_cost_estimate.gas_limit;

        if let Some(max_limit) = self.ctx.transaction_gas_limit {
            if gas_limit > max_limit {
                info!("Message delivery estimated gas exceeds max gas limit");
                return self.on_reprepare();
            }
        }

        self.submission_data = Some(Box::new(SubmissionData {
            metadata,
            gas_limit,
        }));
        PendingOperationResult::Success
    }

    #[instrument]
    async fn submit(&mut self) -> PendingOperationResult {
        make_op_try!(|| self.on_reprepare());

        if self.submitted {
            // this message has already been submitted, possibly not by us
            return PendingOperationResult::Success;
        }

        // skip checking `is_ready` here because the definition of ready is it having
        // been prepared successfully and we don't want to introduce any delay into the
        // submission process.

        let state = self
            .submission_data
            .take()
            .expect("Pending message must be prepared before it can be submitted");

        // We use the estimated gas limit from the prior call to
        // `process_estimate_costs` to avoid a second gas estimation.
        let tx_outcome = op_try!(
            self.ctx
                .destination_mailbox
                .process(&self.message, &state.metadata, Some(state.gas_limit))
                .await,
            "processing message"
        );

        op_try!(critical: self.ctx.origin_gas_payment_enforcer.record_tx_outcome(&self.message, tx_outcome.clone()), "recording tx outcome");
        if tx_outcome.executed {
            info!(
                txid=?tx_outcome.transaction_id,
                "Message successfully processed by transaction"
            );
            self.submitted = true;
            self.reset_attempts();
            self.next_attempt_after = Some(Instant::now() + CONFIRM_DELAY);
            PendingOperationResult::Success
        } else {
            info!(
                txid=?tx_outcome.transaction_id,
                "Transaction attempting to process message reverted"
            );
            self.on_reprepare()
        }
    }

    async fn confirm(&mut self) -> PendingOperationResult {
        make_op_try!(|| {
            // Provider error; just try again later
            // Note: this means that we are using `NotReady` for a retryable error case
            self.inc_attempts();
            PendingOperationResult::NotReady
        });

        debug_assert!(
            self.submitted,
            "Confirm called before message was submitted"
        );

        if !self.is_ready() {
            return PendingOperationResult::NotReady;
        }

        let is_delivered = op_try!(
            self.ctx
                .destination_mailbox
                .delivered(self.message.id())
                .await,
            "Confirming message delivery"
        );
        if is_delivered {
            op_try!(
                critical: self.record_message_process_success(),
                "recording message process success"
            );
            PendingOperationResult::Success
        } else {
            self.reset_attempts();
            self.on_reprepare()
        }
    }

    fn _next_attempt_after(&self) -> Option<Instant> {
        self.next_attempt_after
    }

    #[cfg(test)]
    fn set_retries(&mut self, retries: u32) {
        self.set_retries(retries);
    }
}

impl PendingMessage {
    /// Constructor that tries reading the retry count from the HyperlaneDB in order to recompute the `next_attempt_after`.
    /// In case of failure, behaves like `Self::new(...)`.
    pub fn from_persisted_retries(
        message: HyperlaneMessage,
        ctx: Arc<MessageContext>,
        app_context: Option<String>,
    ) -> Self {
        let mut pm = Self::new(message, ctx, app_context);
        match pm
            .ctx
            .origin_db
            .retrieve_pending_message_retry_count_by_message_id(&pm.message.id())
        {
            Ok(Some(num_retries)) => {
                let next_attempt_after = PendingMessage::calculate_msg_backoff(num_retries)
                    .map(|dur| Instant::now() + dur);
                pm.num_retries = num_retries;
                pm.next_attempt_after = next_attempt_after;
            }
            r => {
                trace!(message_id = ?pm.message.id(), result = ?r, "Failed to read retry count from HyperlaneDB for message.")
            }
        }
        pm
    }

    fn on_reprepare(&mut self) -> PendingOperationResult {
        self.inc_attempts();
        self.submitted = false;
        PendingOperationResult::Reprepare
    }

    fn is_ready(&self) -> bool {
        self.next_attempt_after
            .map(|a| Instant::now() >= a)
            .unwrap_or(true)
    }

    /// Record in HyperlaneDB and various metrics that this process has observed
    /// the successful processing of a message. An `Ok(())` value returned by
    /// this function is the 'commit' point in a message's lifetime for
    /// final processing -- after this function has been seen to
    /// `return Ok(())`, then without a wiped HyperlaneDB, we will never
    /// re-attempt processing for this message again, even after the relayer
    /// restarts.
    fn record_message_process_success(&mut self) -> Result<()> {
        self.ctx
            .origin_db
            .store_processed_by_nonce(&self.message.nonce, &true)?;
        self.ctx.metrics.update_nonce(&self.message);
        self.ctx.metrics.messages_processed.inc();
        Ok(())
    }

    fn reset_attempts(&mut self) {
        self.set_retries(0);
        self.next_attempt_after = None;
        self.last_attempted_at = Instant::now();
    }

    fn inc_attempts(&mut self) {
        self.set_retries(self.num_retries + 1);
        self.last_attempted_at = Instant::now();
        self.next_attempt_after = PendingMessage::calculate_msg_backoff(self.num_retries)
            .map(|dur| self.last_attempted_at + dur);
    }

    fn set_retries(&mut self, retries: u32) {
        self.num_retries = retries;
        self.persist_retries();
    }

    fn persist_retries(&self) {
        if let Err(e) = self
            .ctx
            .origin_db
            .store_pending_message_retry_count_by_message_id(&self.message.id(), &self.num_retries)
        {
            warn!(message_id = ?self.message.id(), err = %e, "Persisting the `num_retries` failed for message");
        }
    }

    /// Get duration we should wait before re-attempting to deliver a message
    /// given the number of retries.
    /// `pub(crate)` for testing purposes
    pub(crate) fn calculate_msg_backoff(num_retries: u32) -> Option<Duration> {
        Some(Duration::from_secs(match num_retries {
            i if i < 1 => return None,
            // wait 10s for the first few attempts; this prevents thrashing
            i if (1..12).contains(&i) => 10,
            // wait 90s to 19.5min with a linear increase
            i if (12..24).contains(&i) => (i as u64 - 11) * 90,
            // wait 30min for the next 12 attempts
            i if (24..36).contains(&i) => 60 * 30,
            // wait 60min for the next 12 attempts
            i if (36..48).contains(&i) => 60 * 60,
            // wait 3h for the next 12 attempts,
            _ => 60 * 60 * 3,
        }))
    }
}

#[derive(Debug)]
pub struct MessageSubmissionMetrics {
    // Fields are public for testing purposes
    pub last_known_nonce: IntGauge,
    pub messages_processed: IntCounter,
}

impl MessageSubmissionMetrics {
    pub fn new(
        metrics: &CoreMetrics,
        origin: &HyperlaneDomain,
        destination: &HyperlaneDomain,
    ) -> Self {
        let origin = origin.name();
        let destination = destination.name();
        Self {
            last_known_nonce: metrics.last_known_message_nonce().with_label_values(&[
                "message_processed",
                origin,
                destination,
            ]),
            messages_processed: metrics
                .messages_processed_count()
                .with_label_values(&[origin, destination]),
        }
    }

    fn update_nonce(&self, msg: &HyperlaneMessage) {
        // this is technically a race condition between `.get` and `.set` but worst case
        // the gauge should get corrected on the next update and is not an issue
        // with a ST runtime
        self.last_known_nonce
            .set(std::cmp::max(self.last_known_nonce.get(), msg.nonce as i64));
    }
}
