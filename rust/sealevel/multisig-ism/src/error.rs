/// Errors relating to a MultisigIsm
#[derive(Copy, Clone, Debug, Eq, thiserror::Error, PartialEq)]
pub enum MultisigIsmError {
    #[error("Invalid signature")]
    InvalidSignature,
    #[error("Threshold not met")]
    ThresholdNotMet,
}

/// Errors relating to an EcdsaSignature
#[derive(Copy, Clone, Debug, Eq, thiserror::Error, PartialEq)]
pub enum EcdsaSignatureError {
    #[error("Invalid signature length")]
    InvalidLength,
    #[error("Invalid signature recovery ID")]
    InvalidRecoveryId,
}
