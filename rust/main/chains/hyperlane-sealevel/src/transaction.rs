use std::collections::HashMap;

use solana_sdk::pubkey::Pubkey;
use solana_transaction_status::option_serializer::OptionSerializer;
use solana_transaction_status::{
    EncodedTransaction, EncodedTransactionWithStatusMeta, UiCompiledInstruction, UiInstruction,
    UiMessage,
};

use hyperlane_core::H512;
use hyperlane_sealevel_mailbox::instruction::Instruction;

use crate::utils::{decode_h512, from_base58};

pub fn search_transaction(
    mailbox_program_id: &Pubkey,
    message_storage_pda_pubkey: &Pubkey,
    transactions: Vec<EncodedTransactionWithStatusMeta>,
) -> Vec<H512> {
    transactions
        .into_iter()
        .filter_map(|tx| match (tx.transaction, tx.meta) {
            // We support only transactions encoded as JSON
            // We need none-empty metadata as well
            (EncodedTransaction::Json(t), Some(m)) => Some((t, m)),
            _ => None,
        })
        .filter_map(|(t, m)| {
            let transaction_hash = match t.signatures.first() {
                Some(h) => h,
                None => return None, // if transaction is not signed, we continue the search
            };

            let transaction_hash = match decode_h512(&transaction_hash) {
                Ok(h) => h,
                Err(_) => return None, // if we cannot parse transaction hash, we continue the search
            };

            // We support only Raw messages initially
            let message = match t.message {
                UiMessage::Raw(m) => m,
                _ => return None,
            };

            let instructions = match m.inner_instructions {
                OptionSerializer::Some(ii) => ii
                    .into_iter()
                    .map(|iii| iii.instructions)
                    .flatten()
                    .flat_map(|ii| match ii {
                        UiInstruction::Compiled(ci) => Some(ci),
                        _ => None,
                    })
                    .collect::<Vec<UiCompiledInstruction>>(),
                OptionSerializer::None | OptionSerializer::Skip => return None,
            };

            Some((transaction_hash, message, instructions))
        })
        .filter_map(|(hash, message, instructions)| {
            let account_keys = message
                .account_keys
                .into_iter()
                .enumerate()
                .map(|(index, key)| (key, index))
                .collect::<HashMap<String, usize>>();

            let mailbox_program_id_str = mailbox_program_id.to_string();
            let mailbox_program_index = match account_keys.get(&mailbox_program_id_str) {
                Some(i) => *i as u8,
                None => return None, // If account keys do not contain Mailbox program, transaction is not message dispatch.
            };

            let message_storage_pda_pubkey_str = message_storage_pda_pubkey.to_string();
            let dispatch_message_pda_account_index =
                match account_keys.get(&message_storage_pda_pubkey_str) {
                    Some(i) => *i as u8,
                    None => return None, // If account keys do not contain dispatch message store PDA account, transaction is not message dispatch.
                };

            let mailbox_program_maybe = instructions
                .into_iter()
                .filter(|instruction| instruction.program_id_index == mailbox_program_index)
                .next();

            let mailbox_program = match mailbox_program_maybe {
                Some(p) => p,
                None => return None, // If transaction does not contain call into Mailbox, transaction is not message dispatch.
            };

            // If Mailbox program does not operate on dispatch message store PDA account, transaction is not message dispatch.
            if !mailbox_program
                .accounts
                .contains(&dispatch_message_pda_account_index)
            {
                return None;
            }

            let instruction_data = match from_base58(&mailbox_program.data) {
                Ok(d) => d,
                Err(_) => return None, // If we cannot decode instruction data, transaction is not message dispatch.
            };

            let instruction = match Instruction::from_instruction_data(&instruction_data) {
                Ok(m) => m,
                Err(_) => return None, // If we cannot parse instruction data, transaction is not message dispatch.
            };

            // If the call into Mailbox program is not OutboxDispatch, transaction is not message dispatch.
            if !matches!(instruction, Instruction::OutboxDispatch(_)) {
                return None;
            }

            Some(hash)
        })
        .collect::<Vec<H512>>()
}

#[cfg(test)]
mod tests;
