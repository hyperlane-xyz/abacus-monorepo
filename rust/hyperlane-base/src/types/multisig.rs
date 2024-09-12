use itertools::Itertools;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use derive_new::new;
use eyre::Result;
use tracing::{debug, instrument};

use hyperlane_core::{
    HyperlaneDomain, MultisigSignedCheckpoint, Signable, SignedCheckpointWithMessageId, H160, H256,
};

use crate::{CheckpointSyncer, CoreMetrics};

/// Weights are scaled by 1e10 as 100%
pub type Weight = u128;
/// Struct for representing both weighted and unweighted types
/// for unweighted, we have (validator, 1), threshold_weight = threshold
/// for weighted, we have (validator, weight)
#[derive(Debug, Clone, Copy, PartialEq, Eq, new)]
pub struct ValidatorWithWeight {
    /// The validator's address
    pub validator: H256,
    /// The validator's weight
    pub weight: Weight,
}

#[derive(Clone)]
struct ValidatorSignedCheckpoint {
    /// The signed checkpoint
    signed_checkpoint: SignedCheckpointWithMessageId,
    /// The weight of the validator
    weight: Weight,
    /// The index of the validator in the list of validators ordered as per the onchain validator set
    ism_index: usize,
}

#[derive(Clone, Default)]
struct ValidatorSignedCheckpoints {
    /// The cumulative weight of the signed checkpoints
    cumulative_weight: Weight,
    /// The signed checkpoints
    signed_checkpoints: Vec<ValidatorSignedCheckpoint>,
}

impl ValidatorSignedCheckpoints {
    /// Pushes a signed checkpoint into the list of signed checkpoints
    fn push(&mut self, checkpoint: ValidatorSignedCheckpoint) {
        self.cumulative_weight += checkpoint.weight;
        self.signed_checkpoints.push(checkpoint);
    }

    /// Converts the list of signed checkpoints into a MultisigSignedCheckpoint
    fn into_multisig_checkpoint(mut self) -> Result<MultisigSignedCheckpoint> {
        self.signed_checkpoints.sort_by_key(|sc| sc.ism_index);

        if self.signed_checkpoints.is_empty() {
            return Err(eyre::eyre!("No signed checkpoints available"));
        }

        let checkpoint = self.signed_checkpoints[0].signed_checkpoint.value.clone();
        let signatures = self
            .signed_checkpoints
            .into_iter()
            .map(|sc| sc.signed_checkpoint.signature)
            .collect();

        Ok(MultisigSignedCheckpoint {
            checkpoint,
            signatures,
        })
    }
}

/// For a particular validator set, fetches signed checkpoints from multiple
/// validators to create MultisigSignedCheckpoints.
#[derive(Clone, Debug, new)]
pub struct MultisigCheckpointSyncer {
    /// The checkpoint syncer for each valid validator signer address
    checkpoint_syncers: HashMap<H160, Arc<dyn CheckpointSyncer>>,
    metrics: Arc<CoreMetrics>,
    app_context: Option<String>,
}

impl MultisigCheckpointSyncer {
    /// Gets the latest checkpoint index from each validator's checkpoint syncer.
    /// Returns a vector of the latest indices, in an unspecified order, and does
    /// not contain indices for validators that did not provide a latest index.
    /// Also updates the validator latest checkpoint metrics.
    pub async fn get_validator_latest_checkpoints_and_update_metrics(
        &self,
        validators: &[H256],
        origin: &HyperlaneDomain,
        destination: &HyperlaneDomain,
    ) -> Vec<(H256, u32)> {
        // Get the latest_index from each validator's checkpoint syncer.
        // If a validator does not return a latest index, None is recorded so
        // this can be surfaced in the metrics.
        let mut latest_indices: HashMap<H160, Option<u32>> =
            HashMap::with_capacity(validators.len());

        for validator in validators {
            let address = H160::from(*validator);
            if let Some(checkpoint_syncer) = self.checkpoint_syncers.get(&address) {
                // Gracefully handle errors getting the latest_index
                match checkpoint_syncer.latest_index().await {
                    Ok(Some(index)) => {
                        debug!(?address, ?index, "Validator returned latest index");
                        latest_indices.insert(H160::from(*validator), Some(index));
                    }
                    result => {
                        debug!(
                            ?address,
                            ?result,
                            "Failed to get latest index from validator"
                        );
                        latest_indices.insert(H160::from(*validator), None);
                    }
                }
            }
        }

        if let Some(app_context) = &self.app_context {
            self.metrics
                .validator_metrics
                .set_validator_latest_checkpoints(
                    origin,
                    destination,
                    app_context.clone(),
                    &latest_indices,
                )
                .await;
        }

        // Filter out any validators that did not return a latest index
        latest_indices
            .into_iter()
            .filter_map(|(validator, index)| index.map(|i| (H256::from(validator), i)))
            .collect()
    }

    /// Attempts to get the latest checkpoint with a quorum of signatures among
    /// validators.
    ///
    /// First iterates through the `latest_index` of each validator's checkpoint
    /// syncer, looking for the highest index that >= `threshold` validators
    /// have returned.
    ///
    /// Attempts to find a quorum of signed checkpoints from that index,
    /// iterating backwards if unsuccessful, until the (optional) index is
    /// reached.
    ///
    /// Note it's possible to not find a quorum.
    #[instrument(err, skip(self))]
    pub async fn fetch_checkpoint_in_range(
        &self,
        weighted_validators: &[ValidatorWithWeight],
        threshold_weight: Weight,
        minimum_index: u32,
        maximum_index: u32,
        origin: &HyperlaneDomain,
        destination: &HyperlaneDomain,
    ) -> Result<Option<MultisigSignedCheckpoint>> {
        let validators: Vec<H256> = weighted_validators.iter().map(|vw| vw.validator).collect();
        let mut latest_indices = self
            .get_validator_latest_checkpoints_and_update_metrics(&validators, origin, destination)
            .await;

        debug!(
            ?latest_indices,
            "Fetched latest indices from checkpoint syncers"
        );

        if latest_indices.is_empty() {
            debug!("No validators returned a latest index");
            return Ok(None);
        }

        // Sort in descending order by index. The n'th index will represent
        // the validator with the highest index for which we (supposedly) have (n+1) signed checkpoints
        latest_indices.sort_by(|a, b| b.1.cmp(&a.1));

        // Find the highest index that meets the threshold weight
        if let Some(highest_quorum_index) =
            self.fetch_highest_quorum_index(weighted_validators, threshold_weight, &latest_indices)
        {
            // The highest viable checkpoint index is the minimum of the highest index
            // we (supposedly) have a quorum for, and the maximum index for which we can
            // generate a proof.
            let start_index = highest_quorum_index.min(maximum_index);
            if minimum_index > start_index {
                debug!(%start_index, %highest_quorum_index, "Highest quorum index is below the minimum index");
                return Ok(None);
            }
            for index in (minimum_index..=start_index).rev() {
                if let Ok(Some(checkpoint)) = self
                    .fetch_checkpoint(weighted_validators, threshold_weight, index)
                    .await
                {
                    return Ok(Some(checkpoint));
                }
            }
        }
        debug!("No checkpoint found in range");
        Ok(None)
    }

    /// Fetches a MultisigSignedCheckpointWithMessageId if there is a quorum.
    /// Validators must reflect the onchain ordering of the set
    /// Returns Ok(None) if there is no quorum.
    #[instrument(err, skip(self))]
    pub async fn fetch_checkpoint(
        &self,
        weighted_validators: &[ValidatorWithWeight],
        threshold_weight: Weight,
        index: u32,
    ) -> Result<Option<MultisigSignedCheckpoint>> {
        // Keeps track of signed validator checkpoints for a particular root.
        // In practice, it's likely that validators will all sign the same root for a
        // particular index, but we'd like to be robust to this not being the case
        let mut signed_checkpoints_per_root: HashMap<H256, ValidatorSignedCheckpoints> =
            HashMap::new();

        let sorted_validators: Vec<(usize, &ValidatorWithWeight)> = weighted_validators
            .iter()
            .enumerate()
            .sorted_by_key(|(_, vw)| std::cmp::Reverse(vw.weight))
            .collect();

        for (ism_index, vw) in &sorted_validators {
            let addr = H160::from(vw.validator);
            if let Some(checkpoint_syncer) = self.checkpoint_syncers.get(&addr) {
                // Gracefully ignore an error fetching the checkpoint from a validator's
                // checkpoint syncer, which can happen if the validator has not
                // signed the checkpoint at `index`.
                if let Ok(Some(signed_checkpoint)) = checkpoint_syncer.fetch_checkpoint(index).await
                {
                    // If the signed checkpoint is for a different index, ignore it
                    if signed_checkpoint.value.index != index {
                        debug!(
                            validator = format!("{:#x}", vw.validator),
                            index = index,
                            checkpoint_index = signed_checkpoint.value.index,
                            "Checkpoint index mismatch"
                        );
                        continue;
                    }

                    // Ensure that the signature is actually by the validator
                    let signer = signed_checkpoint.recover()?;

                    if H256::from(signer) != vw.validator {
                        debug!(
                            validator = format!("{:#x}", vw.validator),
                            index = index,
                            "Checkpoint signature mismatch"
                        );
                        continue;
                    }

                    // Push the signed checkpoint into the hashmap
                    let root = signed_checkpoint.value.root;
                    let signed_checkpoints = signed_checkpoints_per_root.entry(root).or_default();
                    signed_checkpoints.push(ValidatorSignedCheckpoint {
                        signed_checkpoint,
                        weight: vw.weight,
                        ism_index: *ism_index,
                    });

                    // Count the number of signatures for this signed checkpoint
                    let signature_count = signed_checkpoints.signed_checkpoints.len();
                    debug!(
                        validator_with_weight = format!("{{address: {:#x}, weight: {}}}", vw.validator, vw.weight),
                        index = index,
                        root = format!("{:#x}", root),
                        signature_count = signature_count,
                        cumulative_weight = signed_checkpoints.cumulative_weight,
                        sorted_indices = ?sorted_validators,
                        "Found signed checkpoint"
                    );

                    // If we've hit a quorum in weight, create a MultisigSignedCheckpoint
                    if signed_checkpoints.cumulative_weight >= threshold_weight {
                        // to conform to the onchain ordering of the set by address
                        match signed_checkpoints.clone().into_multisig_checkpoint() {
                            Ok(checkpoint) => {
                                debug!(checkpoint=?checkpoint, "Fetched multisig checkpoint");
                                return Ok(Some(checkpoint));
                            }
                            Err(e) => {
                                debug!(error=?e, "Failed to create MultisigSignedCheckpoint");
                                return Ok(None);
                            }
                        }
                    }
                } else {
                    debug!(
                        validator = format!("{:#x}", vw.validator),
                        index = index,
                        "Unable to find signed checkpoint"
                    );
                }
            } else {
                debug!(%vw.validator, "Unable to find checkpoint syncer");
                continue;
            }
        }
        debug!("No quorum checkpoint found for message");
        Ok(None)
    }

    // this function fetches the highest index that meets the threshold weight
    // it assumes sorted_indices is sorted in descending order of index
    // it doesn't assume that the indices contain all validators in weighted_validators
    fn fetch_highest_quorum_index(
        &self,
        weighted_validators: &[ValidatorWithWeight],
        threshold_weight: Weight,
        sorted_indices: &[(H256, u32)],
    ) -> Option<u32> {
        let weight_dict: HashMap<H256, Weight> =
            weighted_validators
                .iter()
                .fold(HashMap::new(), |mut acc, v| {
                    *acc.entry(v.validator).or_insert(0) += v.weight;
                    acc
                });

        let mut cumulative_weight: u128 = 0;
        let mut validators_included = HashSet::new();

        for (validator, index) in sorted_indices {
            if !validators_included.contains(&validator) {
                if let Some(weight) = weight_dict.get(validator) {
                    cumulative_weight += weight;
                    validators_included.insert(validator);
                }
            }

            if cumulative_weight >= threshold_weight {
                return Some(*index);
            }
        }

        // If threshold is not met
        debug!(
            cumulative_weight = cumulative_weight,
            threshold_weight = threshold_weight,
            "Highest quorum index not found"
        );
        None
    }
}

#[cfg(test)]
mod tests {
    use prometheus::Registry;

    use super::*;
    use std::sync::Arc;

    fn setup_syncer() -> MultisigCheckpointSyncer {
        let registry = Registry::new();
        let metrics = CoreMetrics::new("test_agent", 8080, registry).unwrap();
        MultisigCheckpointSyncer::new(HashMap::new(), Arc::new(metrics), None)
    }

    #[test]
    fn test_fetch_highest_quorum_index() {
        let syncer = setup_syncer();
        let validators = vec![
            ValidatorWithWeight::new(H256::from_low_u64_be(1), 30),
            ValidatorWithWeight::new(H256::from_low_u64_be(2), 30),
            ValidatorWithWeight::new(H256::from_low_u64_be(3), 40),
        ];

        // Threshold weight = sum of all weights
        assert_eq!(
            syncer.fetch_highest_quorum_index(
                &validators,
                100,
                &[
                    (H256::from_low_u64_be(1), 10),
                    (H256::from_low_u64_be(2), 9),
                    (H256::from_low_u64_be(3), 8)
                ]
            ),
            Some(8)
        );

        // Threshold weight = 0
        assert_eq!(
            syncer.fetch_highest_quorum_index(&validators, 0, &[(H256::from_low_u64_be(1), 10)]),
            Some(10)
        );

        // 2/3 validators enough for threshold weight
        assert_eq!(
            syncer.fetch_highest_quorum_index(
                &validators,
                60,
                &[
                    (H256::from_low_u64_be(1), 10),
                    (H256::from_low_u64_be(2), 9)
                ]
            ),
            Some(9)
        );

        // Validator in weighted_validators but not in sorted_indices
        assert_eq!(
            syncer.fetch_highest_quorum_index(
                &validators,
                70,
                &[
                    (H256::from_low_u64_be(1), 10),
                    (H256::from_low_u64_be(2), 9)
                ]
            ),
            None
        );

        // Sorted indices 0 for some validators
        assert_eq!(
            syncer.fetch_highest_quorum_index(
                &validators,
                60,
                &[
                    (H256::from_low_u64_be(1), 10),
                    (H256::from_low_u64_be(2), 8),
                    (H256::from_low_u64_be(3), 0)
                ]
            ),
            Some(8)
        );
    }
}
