//! Hyperlane recipient contract that just logs the message data byte vector.
//! **NOT INTENDED FOR USE IN PRODUCTION**
//!
//! Note that a real recipient must define the format for its message and that format is specific
//! to that recipient.

#![deny(warnings)]
// #![deny(missing_docs)] // FIXME
#![deny(unsafe_code)]

use std::str::FromStr as _;

use borsh::ser::BorshSerialize;
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction,
};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program::set_return_data,
    program_error::ProgramError,
    pubkey::Pubkey,
};

// FIXME Read these in at compile time? And don't use harcoded test keys.
solana_program::declare_id!("FZ8hyduJy4GQAfBu9zEiuQtk429Gjc6inwHgEW5MvsEm");

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

const AUTHORITY: &str = "G9CdDjMs6dEd3Tv5eG2ZXo8iKksLRcbHTxpS41sEmX1g";

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    match MessageRecipientInstruction::decode(instruction_data)? {
        MessageRecipientInstruction::InterchainSecurityModule => {
            // Return None, indicating the default ISM should be used
            let ism: Option<Pubkey> = None;
            set_return_data(
                &ism.try_to_vec()
                    .map_err(|err| ProgramError::BorshIoError(err.to_string()))?[..],
            );
            Ok(())
        }
        MessageRecipientInstruction::Handle(instruction) => {
            handle(program_id, accounts, instruction)
        }
    }
}

pub fn handle(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    handle: HandleInstruction,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let hyperlane_mailbox_auth = next_account_info(accounts_iter)?;
    if hyperlane_mailbox_auth.key != &Pubkey::from_str(AUTHORITY).unwrap() {
        return Err(ProgramError::InvalidArgument);
    }
    if !hyperlane_mailbox_auth.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if accounts_iter.next().is_some() {
        return Err(ProgramError::InvalidArgument);
    }
    msg!("hyperlane-sealevel-recipient-echo: {:?}", handle);
    Ok(())
}
