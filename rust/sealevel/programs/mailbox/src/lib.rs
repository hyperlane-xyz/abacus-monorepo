//! Hyperlane Mailbox contract for Sealevel-compatible (Solana Virtual Machine) chains.

#![deny(warnings)]
// #![deny(missing_docs)] // FIXME
#![deny(unsafe_code)]

pub mod accounts;
pub mod error;
pub mod instruction;
pub mod pda_seeds;
pub mod processor;

pub use hyperlane_core;
pub use spl_noop;
