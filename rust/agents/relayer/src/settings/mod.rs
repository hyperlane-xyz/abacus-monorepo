//! Configuration

use abacus_base::decl_settings;

pub mod matching_list;

decl_settings!(Relayer {
    /// The polling interval to check for new signed checkpoints in seconds
    signedcheckpointpollinginterval: String,
    /// The maximum number of times a relayer will try to process a message
    maxprocessingretries: String,
    /// The multisig checkpoint syncer configuration
    multisigcheckpointsyncer: abacus_base::MultisigCheckpointSyncerConf,
    /// This is optional. See `MatchingList` for more.
    whitelist: Option<String>,
    /// This is optional. See `MatchingList` for more.
    blacklist: Option<String>,
});
