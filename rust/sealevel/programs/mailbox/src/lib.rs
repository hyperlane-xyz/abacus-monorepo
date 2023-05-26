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

// FIXME Read these in at compile time? And don't use harcoded test keys.
solana_program::declare_id!("692KZJaoe2KRcD6uhCQDLLXnLNA5ZLnfvdqjE4aX9iu1");

// FIXME set a sane default
pub(crate) static DEFAULT_ISM: &str = "F6dVnLFioQ8hKszqPsmjWPwHn2dJfebgMfztWrzL548V";
