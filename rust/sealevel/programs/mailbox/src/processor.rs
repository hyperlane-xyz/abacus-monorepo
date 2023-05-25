//! Entrypoint, dispatch, and execution for the Hyperlane Sealevel mailbox instruction.

use hyperlane_core::{Decode, Encode, HyperlaneMessage, H256};
#[cfg(not(feature = "no-entrypoint"))]
use solana_program::entrypoint;
use solana_program::{
    account_info::next_account_info,
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{invoke_signed, set_return_data},
    program_error::ProgramError,
    pubkey::Pubkey,
    system_instruction,
    sysvar::{clock::Clock, rent::Rent, Sysvar},
};

use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, VerifyInstruction,
};
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction,
};

use crate::{
    accounts::{
        DispatchedMessage, DispatchedMessageAccount, Inbox, InboxAccount, Outbox, OutboxAccount,
        SizedData,
    },
    error::Error,
    instruction::{
        InboxProcess, InboxSetDefaultModule, Init, Instruction as MailboxIxn, OutboxDispatch,
        OutboxQuery, MAX_MESSAGE_BODY_BYTES, VERSION,
    },
};

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

#[macro_export]
macro_rules! mailbox_authority_pda_seeds {
    ($local_domain:expr) => {{
        &[
            b"hyperlane",
            b"-",
            &$local_domain.to_le_bytes(),
            b"-",
            b"authority",
        ]
    }};

    ($local_domain:expr, $bump_seed:expr) => {{
        &[
            b"hyperlane",
            b"-",
            &$local_domain.to_le_bytes(),
            b"-",
            b"authority",
            &[$bump_seed],
        ]
    }};
}

#[macro_export]
macro_rules! mailbox_inbox_pda_seeds {
    ($local_domain:expr) => {{
        &[
            b"hyperlane",
            b"-",
            &$local_domain.to_le_bytes(),
            b"-",
            b"inbox",
        ]
    }};

    ($local_domain:expr, $bump_seed:expr) => {{
        &[
            b"hyperlane",
            b"-",
            &$local_domain.to_le_bytes(),
            b"-",
            b"inbox",
            &[$bump_seed],
        ]
    }};
}

#[macro_export]
macro_rules! mailbox_outbox_pda_seeds {
    ($local_domain:expr) => {{
        &[
            b"hyperlane",
            b"-",
            &$local_domain.to_le_bytes(),
            b"-",
            b"outbox",
        ]
    }};

    ($local_domain:expr, $bump_seed:expr) => {{
        &[
            b"hyperlane",
            b"-",
            &$local_domain.to_le_bytes(),
            b"-",
            b"outbox",
            &[$bump_seed],
        ]
    }};
}

/// Gets the PDA seeds for a message storage account that's
/// based upon the pubkey of a unique message account.
#[macro_export]
macro_rules! mailbox_dispatched_message_pda_seeds {
    ($unique_message_pubkey:expr) => {{
        &[
            b"hyperlane",
            b"-",
            b"dispatched_message",
            b"-",
            $unique_message_pubkey.as_ref(),
        ]
    }};

    ($unique_message_pubkey:expr, $bump_seed:expr) => {{
        &[
            b"hyperlane",
            b"-",
            b"dispatched_message",
            b"-",
            $unique_message_pubkey.as_ref(),
            &[$bump_seed],
        ]
    }};
}

/// The PDA seeds relating to a program's dispatch authority.
#[macro_export]
macro_rules! mailbox_message_dispatch_authority_pda_seeds {
    () => {{
        &[b"hyperlane_dispatcher", b"-", b"dispatch_authority"]
    }};

    ($bump_seed:expr) => {{
        &[
            b"hyperlane_dispatcher",
            b"-",
            b"dispatch_authority",
            &[$bump_seed],
        ]
    }};
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    match MailboxIxn::from_instruction_data(instruction_data)? {
        MailboxIxn::Init(init) => initialize(program_id, accounts, init),
        MailboxIxn::InboxProcess(process) => inbox_process(program_id, accounts, process),
        MailboxIxn::InboxSetDefaultModule(ism) => inbox_set_default_ism(program_id, accounts, ism),
        MailboxIxn::OutboxDispatch(dispatch) => outbox_dispatch(program_id, accounts, dispatch),
        MailboxIxn::OutboxGetCount(query) => outbox_get_count(program_id, accounts, query),
        MailboxIxn::OutboxGetLatestCheckpoint(query) => {
            outbox_get_latest_checkpoint(program_id, accounts, query)
        }
        MailboxIxn::OutboxGetRoot(query) => outbox_get_root(program_id, accounts, query),
    }
    .map_err(|err| {
        msg!("{}", err);
        err
    })
}

fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], init: Init) -> ProgramResult {
    // On chain create appears to use realloc which is limited to 1024 byte increments.
    let mailbox_size = 2048;
    let accounts_iter = &mut accounts.iter();

    let system_program = next_account_info(accounts_iter)?;
    if system_program.key != &solana_program::system_program::ID {
        return Err(ProgramError::InvalidArgument);
    }

    let payer_account = next_account_info(accounts_iter)?;

    let auth_account = next_account_info(accounts_iter)?;
    let (auth_key, auth_bump) =
        Pubkey::find_program_address(mailbox_authority_pda_seeds!(init.local_domain), program_id);
    if &auth_key != auth_account.key {
        return Err(ProgramError::InvalidArgument);
    }
    invoke_signed(
        &system_instruction::create_account(
            payer_account.key,
            auth_account.key,
            Rent::default().minimum_balance(0),
            0,
            program_id,
        ),
        &[payer_account.clone(), auth_account.clone()],
        &[mailbox_authority_pda_seeds!(init.local_domain, auth_bump)],
    )?;

    let inbox_account = next_account_info(accounts_iter)?;
    let (inbox_key, inbox_bump) =
        Pubkey::find_program_address(mailbox_inbox_pda_seeds!(init.local_domain), program_id);
    if &inbox_key != inbox_account.key {
        return Err(ProgramError::InvalidArgument);
    }
    invoke_signed(
        &system_instruction::create_account(
            payer_account.key,
            inbox_account.key,
            Rent::default().minimum_balance(mailbox_size.try_into().unwrap()),
            mailbox_size,
            program_id,
        ),
        &[payer_account.clone(), inbox_account.clone()],
        &[mailbox_inbox_pda_seeds!(init.local_domain, inbox_bump)],
    )?;

    let outbox_account = next_account_info(accounts_iter)?;
    let (outbox_key, outbox_bump) =
        Pubkey::find_program_address(mailbox_outbox_pda_seeds!(init.local_domain), program_id);
    if &outbox_key != outbox_account.key {
        return Err(ProgramError::InvalidArgument);
    }
    invoke_signed(
        &system_instruction::create_account(
            payer_account.key,
            outbox_account.key,
            Rent::default().minimum_balance(mailbox_size.try_into().unwrap()),
            mailbox_size,
            program_id,
        ),
        &[payer_account.clone(), outbox_account.clone()],
        &[mailbox_outbox_pda_seeds!(init.local_domain, outbox_bump)],
    )?;

    let inbox = Inbox {
        local_domain: init.local_domain,
        auth_bump_seed: auth_bump,
        inbox_bump_seed: inbox_bump,
        ..Default::default()
    };
    InboxAccount::from(inbox).store(inbox_account, true)?;

    let outbox = Outbox {
        local_domain: init.local_domain,
        auth_bump_seed: auth_bump,
        outbox_bump_seed: outbox_bump,
        ..Default::default()
    };
    OutboxAccount::from(outbox).store(outbox_account, true)?;

    Ok(())
}

// TODO add more strict checks on permissions for all accounts that are passed in, e.g., bail if
// we expected an account to be read only but it is writable. Could build this into the AccountData
// struct impl and provide more fetch methods.

/// Accounts:
/// 0.    [writable] Inbox PDA
/// 1.    [writable] Authority PDA
/// 2.    [executable] SPL noop
/// 3.    [executable] ISM
/// 4..N. [??] ISM accounts, if present
/// N+1.  [executable] Recipient program
/// N+2.. [??] Recipient accounts
fn inbox_process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    process: InboxProcess,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let message = HyperlaneMessage::read_from(&mut std::io::Cursor::new(&process.message))
        .map_err(|_| ProgramError::from(Error::MalformattedHyperlaneMessage))?;
    if message.version != VERSION {
        return Err(ProgramError::from(Error::UnsupportedMessageVersion));
    }
    let local_domain = message.destination;

    let inbox_account = next_account_info(accounts_iter)?;
    let mut inbox = InboxAccount::fetch(&mut &inbox_account.data.borrow_mut()[..])?.into_inner();
    let expected_inbox_key = Pubkey::create_program_address(
        mailbox_inbox_pda_seeds!(local_domain, inbox.inbox_bump_seed),
        program_id,
    )?;
    if inbox_account.key != &expected_inbox_key {
        return Err(ProgramError::InvalidArgument);
    }
    if inbox_account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    let auth_account = next_account_info(accounts_iter)?;
    let expected_auth_key = Pubkey::create_program_address(
        mailbox_authority_pda_seeds!(local_domain, inbox.auth_bump_seed),
        program_id,
    )?;
    if auth_account.key != &expected_auth_key {
        return Err(ProgramError::InvalidArgument);
    }
    if auth_account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    let spl_noop = next_account_info(accounts_iter)?;
    if spl_noop.key != &spl_noop::id() || !spl_noop.executable {
        return Err(ProgramError::InvalidArgument);
    }

    let id = message.id();
    if inbox.delivered.contains(&id) {
        return Err(ProgramError::from(Error::DuplicateMessage));
    }
    inbox.delivered.insert(id);

    if inbox.ism != *next_account_info(accounts_iter)?.key {
        return Err(ProgramError::from(Error::AccountOutOfOrder));
    }
    let mut ism_accounts = vec![auth_account.clone()];
    let mut ism_account_metas = vec![AccountMeta {
        pubkey: *auth_account.key,
        is_signer: true,
        is_writable: false,
    }];
    for pubkey in &inbox.ism_accounts {
        let meta = AccountMeta {
            pubkey: *pubkey,
            // TODO this should probably be provided up front...
            is_signer: false,
            is_writable: false,
        };
        let info = next_account_info(accounts_iter)?;
        if info.key != pubkey {
            return Err(ProgramError::from(Error::AccountOutOfOrder));
        }
        ism_accounts.push(info.clone());
        ism_account_metas.push(meta);
    }

    let recp_prog_id = Pubkey::new_from_array(message.recipient.0);
    if recp_prog_id != *next_account_info(accounts_iter)?.key {
        return Err(ProgramError::from(Error::AccountOutOfOrder));
    }
    let mut recp_accounts = vec![auth_account.clone()];
    let mut recp_account_metas = vec![AccountMeta {
        pubkey: *auth_account.key,
        is_signer: true,
        is_writable: false,
    }];
    for account_info in accounts_iter {
        recp_accounts.push(account_info.clone());
        recp_account_metas.push(AccountMeta {
            pubkey: *account_info.key,
            is_signer: account_info.is_signer,
            is_writable: account_info.is_writable,
        });
    }

    let auth_seeds: &[&[u8]] =
        mailbox_authority_pda_seeds!(inbox.local_domain, inbox.auth_bump_seed);

    let ism_ixn = InterchainSecurityModuleInstruction::Verify(VerifyInstruction {
        metadata: process.metadata,
        message: process.message,
    });
    let verify = Instruction::new_with_bytes(inbox.ism, &ism_ixn.encode()?, ism_account_metas);
    invoke_signed(&verify, &ism_accounts, &[auth_seeds])?;

    let recp_ixn = MessageRecipientInstruction::Handle(HandleInstruction::new(
        message.origin,
        message.sender,
        message.body,
    ));
    let recieve = Instruction::new_with_bytes(
        message.recipient.0.into(),
        &recp_ixn.encode()?,
        recp_account_metas,
    );
    invoke_signed(&recieve, &recp_accounts, &[auth_seeds])?;

    // FIXME do we need an equivalent of both ProcessId and Process solidity events?
    let noop_cpi_log = Instruction {
        program_id: spl_noop::id(),
        accounts: vec![],
        data: format!("Hyperlane inbox: {:?}", id).into_bytes(),
    };
    invoke_signed(&noop_cpi_log, &[], &[auth_seeds])?;

    msg!("Hyperlane inbox processed message {:?}", id);

    // FIXME store before or after recipient cpi? What if fail to write but recipient cpi okay?
    InboxAccount::from(inbox).store(inbox_account, true)?;
    Ok(())
}

fn inbox_set_default_ism(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    ism: InboxSetDefaultModule,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let inbox_account = next_account_info(accounts_iter)?;
    let mut inbox = InboxAccount::fetch(&mut &inbox_account.data.borrow_mut()[..])?.into_inner();
    let expected_inbox_key = Pubkey::create_program_address(
        mailbox_inbox_pda_seeds!(ism.local_domain, inbox.inbox_bump_seed),
        program_id,
    )?;
    if inbox_account.key != &expected_inbox_key {
        return Err(ProgramError::InvalidArgument);
    }
    if inbox_account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    if accounts_iter.next().is_some() {
        return Err(ProgramError::from(Error::ExtraneousAccount));
    }

    inbox.ism = ism.program_id;
    inbox.ism_accounts = ism.accounts;
    InboxAccount::from(inbox).store(inbox_account, true)?;

    Ok(())
}

/// Dispatches a message.
/// If the message sender is a program, the message sender signer *must* be
/// the PDA for the sending program with the seeds `mailbox_message_dispatch_authority_pda_seeds!()`.
/// in order for the sender field of the message to be set to the sending program
/// ID. Otherwise, the sender field of the message is set to the message sender signer.
///
/// Accounts:
///
/// 0. [writeable] Outbox PDA.
/// 1. [signer] Message sender signer.
/// 2. [executable] System program.
/// 3. [executable] SPL Noop program.
/// 4. [signer] Payer.
/// 5. [signer] Unique message account.
/// 6. [writeable] Dispatched message PDA. An empty message PDA relating to the seeds
///    `mailbox_dispatched_message_pda_seeds` where the message contents will be stored.
fn outbox_dispatch(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    dispatch: OutboxDispatch,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Outbox PDA.
    let outbox_account = next_account_info(accounts_iter)?;
    let mut outbox = OutboxAccount::fetch(&mut &outbox_account.data.borrow_mut()[..])?.into_inner();
    let expected_outbox_key = Pubkey::create_program_address(
        mailbox_outbox_pda_seeds!(dispatch.local_domain, outbox.outbox_bump_seed),
        program_id,
    )?;
    if outbox_account.key != &expected_outbox_key || outbox_account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !outbox_account.is_writable {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 1: Message sender signer.
    let sender_signer = next_account_info(accounts_iter)?;
    if !sender_signer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    // If the sender signer key differs from the specified dispatch.sender,
    // we need to confirm that the sender signer has the authority to sign
    // on behalf of the dispatch.sender!
    if *sender_signer.key != dispatch.sender {
        // TODO would be great to have the bump in here...
        // Maybe shove it into the data of the sender_signer?
        let (expected_signer_key, _expected_signer_bump) = Pubkey::find_program_address(
            mailbox_message_dispatch_authority_pda_seeds!(),
            &dispatch.sender,
        );
        // If the sender_signer isn't the expected dispatch authority for the
        // specified dispatch.sender, fail.
        if expected_signer_key != *sender_signer.key {
            return Err(ProgramError::MissingRequiredSignature);
        }
    }

    // Account 2: System program.
    let system_program_account = next_account_info(accounts_iter)?;
    if system_program_account.key != &solana_program::system_program::id() {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 3: SPL Noop program.
    let spl_noop = next_account_info(accounts_iter)?;
    if spl_noop.key != &spl_noop::id() || !spl_noop.executable {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 4: Payer.
    let payer_account = next_account_info(accounts_iter)?;
    if !payer_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 5: Unique message account.
    // Uniqueness is enforced by making sure the message storage PDA based on
    // this unique message account is empty, which is done next.
    let unique_message_account = next_account_info(accounts_iter)?;
    if !unique_message_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 6: Dispatched message PDA.
    let dispatched_message_pda = next_account_info(accounts_iter)?;
    let (dispatched_message_key, dispatched_message_bump) = Pubkey::find_program_address(
        mailbox_dispatched_message_pda_seeds!(unique_message_account.key),
        program_id,
    );
    if dispatched_message_key != *dispatched_message_pda.key {
        return Err(ProgramError::IncorrectProgramId);
    }
    // Make sure an account can't be written to that already exists.
    if !dispatched_message_pda.data_is_empty()
        || *dispatched_message_pda.owner != solana_program::system_program::id()
        || dispatched_message_pda.lamports() != 0
    {
        return Err(ProgramError::InvalidArgument);
    }

    if accounts_iter.next().is_some() {
        return Err(ProgramError::from(Error::ExtraneousAccount));
    }

    if dispatch.message_body.len() > MAX_MESSAGE_BODY_BYTES {
        return Err(ProgramError::from(Error::MaxMessageSizeExceeded));
    }

    let count = outbox
        .tree
        .count()
        .try_into()
        .expect("Too many messages in outbox tree");
    let message = HyperlaneMessage {
        version: VERSION,
        nonce: count,
        origin: dispatch.local_domain,
        sender: H256(dispatch.sender.to_bytes()),
        destination: dispatch.destination_domain,
        recipient: dispatch.recipient,
        body: dispatch.message_body,
    };
    let mut encoded_message = vec![];
    message
        .write_to(&mut encoded_message)
        .map_err(|_| ProgramError::from(Error::MalformattedMessage))?;

    let id = message.id();
    outbox.tree.ingest(id);

    // Create the dispatched message PDA.
    let dispatched_message_account = DispatchedMessageAccount::from(DispatchedMessage::new(
        message.nonce,
        Clock::get()?.slot,
        *unique_message_account.key,
        encoded_message,
    ));
    let dispatched_message_account_size: usize = dispatched_message_account.size();
    invoke_signed(
        &system_instruction::create_account(
            payer_account.key,
            dispatched_message_pda.key,
            Rent::default().minimum_balance(dispatched_message_account_size),
            dispatched_message_account_size.try_into().unwrap(),
            program_id,
        ),
        &[payer_account.clone(), dispatched_message_pda.clone()],
        &[mailbox_dispatched_message_pda_seeds!(
            unique_message_account.key,
            dispatched_message_bump
        )],
    )?;
    dispatched_message_account.store(dispatched_message_pda, false)?;

    // Log the message using the SPL Noop program.
    let noop_cpi_log = Instruction {
        program_id: *spl_noop.key,
        accounts: vec![],
        data: dispatched_message_pda.data.borrow().to_vec(),
    };
    // TODO: I expect these will need to go
    let auth_seeds: &[&[u8]] =
        mailbox_authority_pda_seeds!(outbox.local_domain, outbox.auth_bump_seed);
    invoke_signed(&noop_cpi_log, &[], &[auth_seeds])?;

    // Store the Outbox with the new updates.
    OutboxAccount::from(outbox).store(outbox_account, true)?;

    set_return_data(id.as_ref());
    Ok(())
}

fn outbox_get_count(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    query: OutboxQuery,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let outbox_account = next_account_info(accounts_iter)?;
    let outbox = OutboxAccount::fetch(&mut &outbox_account.data.borrow_mut()[..])?.into_inner();
    let expected_outbox_key = Pubkey::create_program_address(
        mailbox_outbox_pda_seeds!(query.local_domain, outbox.outbox_bump_seed),
        program_id,
    )?;
    if outbox_account.key != &expected_outbox_key {
        return Err(ProgramError::InvalidArgument);
    }
    if outbox_account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    if accounts_iter.next().is_some() {
        return Err(ProgramError::from(Error::ExtraneousAccount));
    }

    let count: u32 = outbox
        .tree
        .count()
        .try_into()
        .expect("Too many messages in outbox tree");
    set_return_data(&count.to_le_bytes());
    Ok(())
}

fn outbox_get_latest_checkpoint(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    query: OutboxQuery,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let outbox_account = next_account_info(accounts_iter)?;
    let outbox = OutboxAccount::fetch(&mut &outbox_account.data.borrow_mut()[..])?.into_inner();
    let expected_outbox_key = Pubkey::create_program_address(
        mailbox_outbox_pda_seeds!(query.local_domain, outbox.outbox_bump_seed),
        program_id,
    )?;
    if outbox_account.key != &expected_outbox_key {
        return Err(ProgramError::InvalidArgument);
    }
    if outbox_account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    if accounts_iter.next().is_some() {
        return Err(ProgramError::from(Error::ExtraneousAccount));
    }

    let root = outbox.tree.root();
    let count: u32 = outbox
        .tree
        .count()
        .try_into()
        .expect("Too many messages in outbox tree");

    let mut ret_buf = [0; 36];
    ret_buf[0..31].copy_from_slice(root.as_ref());
    ret_buf[32..].copy_from_slice(&count.to_le_bytes());
    set_return_data(&ret_buf);
    Ok(())
}

fn outbox_get_root(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    query: OutboxQuery,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let outbox_account = next_account_info(accounts_iter)?;
    let outbox = OutboxAccount::fetch(&mut &outbox_account.data.borrow_mut()[..])?.into_inner();
    let expected_outbox_key = Pubkey::create_program_address(
        mailbox_outbox_pda_seeds!(query.local_domain, outbox.outbox_bump_seed),
        program_id,
    )?;
    if outbox_account.key != &expected_outbox_key {
        return Err(ProgramError::InvalidArgument);
    }
    if outbox_account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    if accounts_iter.next().is_some() {
        return Err(ProgramError::from(Error::ExtraneousAccount));
    }

    let root = outbox.tree.root();
    set_return_data(root.as_ref());
    Ok(())
}

#[cfg(test)]
mod test {
    use super::*;

    use std::str::FromStr;

    use hyperlane_core::{accumulator::incremental::IncrementalMerkle as MerkleTree, Encode};
    use itertools::Itertools as _;
    use solana_program::clock::Epoch;

    struct SyscallStubs {}
    impl solana_program::program_stubs::SyscallStubs for SyscallStubs {
        fn sol_log(&self, message: &str) {
            log::info!("{}", message);
        }
        fn sol_log_data(&self, fields: &[&[u8]]) {
            log::info!("data: {}", fields.iter().map(base64::encode).join(" "));
        }
    }

    struct ExampleMetadata {
        // Depends on which ISM is used.
        pub root: H256,
        pub index: u32,
        pub leaf_index: u32,
        // pub proof: [H256; 32],
        pub signatures: Vec<H256>,
    }
    impl Encode for ExampleMetadata {
        fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
        where
            W: std::io::Write,
        {
            writer.write_all(&self.root.as_ref())?;
            writer.write_all(&self.index.to_be_bytes())?;
            writer.write_all(&self.leaf_index.to_be_bytes())?;
            // for hash in self.proof {
            //     writer.write_all(hash.as_ref())?;
            // }
            for signature in &self.signatures {
                writer.write_all(signature.as_ref())?;
            }
            Ok(32 + 4 + 4 + (32 * 32) + (self.signatures.len() * 32))
        }
    }

    fn setup_logging() {
        solana_program::program_stubs::set_syscall_stubs(Box::new(SyscallStubs {}));
        testing_logger::setup();
    }

    #[test]
    fn test_inbox_process() {
        setup_logging();

        let local_domain = u32::MAX;
        let mailbox_program_id = Pubkey::new_unique();

        let (auth_account_key, auth_bump_seed) = Pubkey::find_program_address(
            mailbox_authority_pda_seeds!(local_domain),
            &mailbox_program_id,
        );
        let mut auth_account_lamports = 0;
        let mut auth_account_data = vec![];
        let auth_account = AccountInfo::new(
            // Public key of the account
            &auth_account_key,
            // Was the transaction signed by this account's public key?
            false,
            // Is the account writable?
            true,
            // The lamports in the account. Modifiable by programs.
            &mut auth_account_lamports,
            // The data held in this account. Modifiable by programs.
            &mut auth_account_data,
            // Program that owns this account.
            &mailbox_program_id,
            // This account's data contains a loaded program (and is now read-only).
            false,
            // The epoch at which this account will next owe rent.
            Epoch::default(),
        );

        let (inbox_account_key, inbox_bump_seed) = Pubkey::find_program_address(
            mailbox_inbox_pda_seeds!(local_domain),
            &mailbox_program_id,
        );
        let mut inbox_account_lamports = 0;
        let mut inbox_account_data = vec![0_u8; 2048];
        let inbox_account = AccountInfo::new(
            &inbox_account_key,
            false,
            true,
            &mut inbox_account_lamports,
            &mut inbox_account_data,
            &mailbox_program_id,
            false,
            Epoch::default(),
        );
        let inbox_init_data = Inbox {
            local_domain,
            auth_bump_seed,
            inbox_bump_seed,
            ..Default::default()
        };
        InboxAccount::from(inbox_init_data)
            .store(&inbox_account, false)
            .unwrap();

        let ism_account_key = Pubkey::from_str(crate::DEFAULT_ISM).unwrap();
        let mut ism_account_lamports = 0;
        let mut ism_account_data = vec![0_u8; 1024];
        let ism_account = AccountInfo::new(
            &ism_account_key,
            false,
            false,
            &mut ism_account_lamports,
            &mut ism_account_data,
            &mailbox_program_id,
            true,
            Epoch::default(),
        );
        // Must add to account vec further down if/when there are ism data accounts.
        assert!(crate::DEFAULT_ISM_ACCOUNTS.is_empty());

        let recp_account_key = Pubkey::new_from_array([42; 32]);
        let mut recp_account_lamports = 0;
        let mut recp_account_data = vec![0_u8; 1024];
        let recp_account = AccountInfo::new(
            &recp_account_key,
            false,
            false,
            &mut recp_account_lamports,
            &mut recp_account_data,
            &mailbox_program_id,
            true,
            Epoch::default(),
        );
        // Assume no recpient data accounts for now.

        let message = HyperlaneMessage {
            version: VERSION,
            nonce: 1,
            origin: u32::MAX,
            sender: H256::repeat_byte(69),
            destination: u32::MAX,
            recipient: H256::from(recp_account_key.to_bytes()),
            body: "Hello, World!".bytes().collect(),
        };
        let mut encoded_message = vec![];
        message.write_to(&mut encoded_message).unwrap();
        let metadata = ExampleMetadata {
            root: Default::default(),
            index: 1,
            signatures: vec![],
            // proof: Default::default(),
            leaf_index: message.nonce,
        };
        let mut encoded_metadata = vec![];
        metadata.write_to(&mut encoded_metadata).unwrap();

        let system_program_id = solana_program::system_program::id();

        let mut spl_noop_lamports = 0;
        let mut spl_noop_data = vec![];
        let spl_noop_id = spl_noop::id();
        let spl_noop_account = AccountInfo::new(
            &spl_noop_id,
            false,
            false,
            &mut spl_noop_lamports,
            &mut spl_noop_data,
            &system_program_id,
            true,
            Epoch::default(),
        );

        let accounts = [
            inbox_account,
            auth_account,
            spl_noop_account,
            ism_account,
            recp_account,
        ];
        let inbox_process = InboxProcess {
            metadata: encoded_metadata,
            message: encoded_message,
        };
        let instruction_data = MailboxIxn::InboxProcess(inbox_process)
            .into_instruction_data()
            .unwrap();

        let inbox = InboxAccount::fetch(&mut &accounts[0].data.borrow_mut()[..])
            .unwrap()
            .into_inner();
        assert_eq!(inbox.delivered.len(), 0);

        process_instruction(&mailbox_program_id, &accounts, &instruction_data).unwrap();
        testing_logger::validate(|logs| {
            assert_eq!(logs.len(), 4);
            assert_eq!(logs[0].level, log::Level::Info);
            assert_eq!(
                logs[0].body,
                "SyscallStubs: sol_invoke_signed() not available"
            );
            assert_eq!(logs[1].level, log::Level::Info);
            assert_eq!(
                logs[1].body,
                "SyscallStubs: sol_invoke_signed() not available"
            );
            assert_eq!(logs[2].level, log::Level::Info);
            assert_eq!(
                logs[2].body,
                "SyscallStubs: sol_invoke_signed() not available"
            );
            assert_eq!(logs[3].level, log::Level::Info);
            assert_eq!(
                logs[3].body,
                format!("Hyperlane inbox processed message {:?}", message.id()),
            );
        });
        let inbox = InboxAccount::fetch(&mut &accounts[0].data.borrow_mut()[..])
            .unwrap()
            .into_inner();
        assert_eq!(inbox.delivered.len(), 1);
        assert!(inbox.delivered.contains(&message.id(),));
    }

    // TODO: this is ignored because Dispatch now creates a PDA for outbound messages,
    // which must be done in a functional test.
    // Move this to a functional test!
    #[ignore]
    #[test]
    fn test_outbox_dispatch() {
        setup_logging();

        let local_domain = u32::MAX;
        let mailbox_program_id = Pubkey::new_unique();

        let (outbox_account_key, outbox_bump_seed) = Pubkey::find_program_address(
            mailbox_outbox_pda_seeds!(local_domain),
            &mailbox_program_id,
        );
        let mut outbox_account_lamports = 0;
        let mut outbox_account_data = vec![0_u8; 2048];
        let outbox_account = AccountInfo::new(
            &outbox_account_key,
            false,
            true,
            &mut outbox_account_lamports,
            &mut outbox_account_data,
            &mailbox_program_id,
            false,
            Epoch::default(),
        );
        let outbox_init_data = Outbox {
            local_domain,
            outbox_bump_seed,
            ..Default::default()
        };
        OutboxAccount::from(outbox_init_data)
            .store(&outbox_account, false)
            .unwrap();

        let sender = Pubkey::new_from_array([6; 32]);
        let hyperlane_message = HyperlaneMessage {
            version: VERSION,
            nonce: 0,
            origin: u32::MAX,
            sender: H256(sender.to_bytes()),
            destination: u32::MAX,
            recipient: H256([9; 32]),
            body: "Hello, World!".bytes().collect(),
        };
        let dispatch = OutboxDispatch {
            sender: sender.clone(),
            local_domain: hyperlane_message.origin,
            destination_domain: hyperlane_message.destination,
            recipient: hyperlane_message.recipient,
            message_body: hyperlane_message.body.clone(),
        };
        let instruction_data = MailboxIxn::OutboxDispatch(dispatch)
            .into_instruction_data()
            .unwrap();

        let system_program_id = solana_program::system_program::id();

        let mut sender_account_lamports = 0;
        let mut sender_account_data = vec![];
        let sender_account = AccountInfo::new(
            &sender,
            true,
            false,
            &mut sender_account_lamports,
            &mut sender_account_data,
            &system_program_id,
            false,
            Epoch::default(),
        );

        let mut system_program_lamports = 0;
        let mut system_program_data = vec![];
        let system_program_account = AccountInfo::new(
            &system_program_id,
            false,
            false,
            &mut system_program_lamports,
            &mut system_program_data,
            &system_program_id,
            true,
            Epoch::default(),
        );

        let mut spl_noop_lamports = 0;
        let mut spl_noop_data = vec![];
        let spl_noop_id = spl_noop::id();
        let spl_noop_account = AccountInfo::new(
            &spl_noop_id,
            false,
            false,
            &mut spl_noop_lamports,
            &mut spl_noop_data,
            &system_program_id,
            true,
            Epoch::default(),
        );

        let payer = Pubkey::new_from_array([69; 32]);
        let mut payer_account_lamports = 1000000000;
        let mut payer_account_data = vec![];
        let payer_account = AccountInfo::new(
            &payer,
            true,
            false,
            &mut payer_account_lamports,
            &mut payer_account_data,
            &system_program_id,
            false,
            Epoch::default(),
        );

        let unique_message_account_pubkey = Pubkey::new_from_array([22; 32]);
        let mut unique_message_account_lamports = 0;
        let mut unique_message_account_data = vec![];
        let unique_message_account = AccountInfo::new(
            &unique_message_account_pubkey,
            true,
            false,
            &mut unique_message_account_lamports,
            &mut unique_message_account_data,
            &system_program_id,
            false,
            Epoch::default(),
        );

        let (dispatched_message_account_pubkey, _dispatched_message_bump) =
            Pubkey::find_program_address(
                mailbox_dispatched_message_pda_seeds!(unique_message_account.key),
                &mailbox_program_id,
            );
        let mut dispatched_message_account_lamports = 0;
        let mut dispatched_message_account_data = vec![];
        let dispatched_message_account = AccountInfo::new(
            &dispatched_message_account_pubkey,
            false,
            true,
            &mut dispatched_message_account_lamports,
            &mut dispatched_message_account_data,
            &system_program_id,
            false,
            Epoch::default(),
        );

        let accounts = vec![
            outbox_account,
            sender_account,
            system_program_account,
            spl_noop_account,
            payer_account,
            unique_message_account,
            dispatched_message_account,
        ];
        let outbox = OutboxAccount::fetch(&mut &accounts[0].data.borrow_mut()[..])
            .unwrap()
            .into_inner();
        assert_eq!(outbox.tree.count(), 0);
        assert_eq!(outbox.tree.root(), MerkleTree::default().root());

        process_instruction(&mailbox_program_id, &accounts, &instruction_data).unwrap();

        let mut formatted = vec![];
        hyperlane_message.write_to(&mut formatted).unwrap();

        testing_logger::validate(|logs| {
            assert_eq!(logs.len(), 2);
            assert_eq!(logs[0].level, log::Level::Info);
            assert_eq!(
                logs[0].body,
                format!("data = {}", bs58::encode(&formatted).into_string()),
            );
            assert_eq!(logs[1].level, log::Level::Info);
            assert_eq!(
                logs[1].body,
                "SyscallStubs: sol_invoke_signed() not available"
            );
        });
        let outbox = OutboxAccount::fetch(&mut &accounts[0].data.borrow_mut()[..])
            .unwrap()
            .into_inner();
        assert_eq!(outbox.tree.count(), 1);
        assert_eq!(
            outbox.tree.root(),
            // TODO confirm this is accurate
            H256::from_str("0xeb8a682022a127228200c65404f0be85f8d5827712f112d7b92928cdbdbcc073")
                .unwrap()
        );
    }
}
