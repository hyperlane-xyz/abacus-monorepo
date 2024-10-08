use std::{
    collections::HashMap,
    fs::File,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread::sleep,
    time::Duration,
};

use solana_client::{client_error::ClientError, rpc_client::RpcClient};
use solana_sdk::{
    commitment_config::CommitmentConfig,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
};

const SOLANA_DOMAIN: u32 = 1399811149;

pub(crate) fn account_exists(client: &RpcClient, account: &Pubkey) -> Result<bool, ClientError> {
    // Using `get_account_with_commitment` instead of `get_account` so we get Ok(None) when the account
    // doesn't exist, rather than an error
    let exists = client
        .get_account_with_commitment(account, CommitmentConfig::processed())?
        .value
        .is_some();
    Ok(exists)
}

pub(crate) fn deploy_program_idempotent(
    payer_keypair_path: &str,
    program_keypair: &Keypair,
    program_keypair_path: &str,
    program_path: &str,
    url: &str,
    local_domain: u32,
) -> Result<(), ClientError> {
    let client = RpcClient::new(url.to_string());
    if !account_exists(&client, &program_keypair.pubkey())? {
        deploy_program(
            payer_keypair_path,
            program_keypair_path,
            program_path,
            url,
            local_domain,
        );
    } else {
        println!("Program {} already deployed", program_keypair.pubkey());
    }

    Ok(())
}

pub(crate) fn deploy_program(
    payer_keypair_path: &str,
    program_keypair_path: &str,
    program_path: &str,
    url: &str,
    local_domain: u32,
) {
    let mut command = vec![
        "solana",
        "--url",
        url,
        "-k",
        payer_keypair_path,
        "program",
        "deploy",
        program_path,
        "--upgrade-authority",
        payer_keypair_path,
        "--program-id",
        program_keypair_path,
    ];

    if local_domain.eq(&SOLANA_DOMAIN) {
        // May need tweaking depending on gas prices / available balance
        command.append(&mut vec!["--with-compute-unit-price", "550000"]);
    }

    build_cmd(command.as_slice(), None, None);

    // TODO: use commitment level instead of just sleeping here?
    println!("Sleeping for 2 seconds to allow program to be deployed");
    sleep(Duration::from_secs(2));
}

pub(crate) fn create_new_directory(parent_dir: &Path, name: &str) -> PathBuf {
    let path = parent_dir.join(name);
    std::fs::create_dir_all(path.clone())
        .unwrap_or_else(|_| panic!("Failed to create directory {}", path.display()));
    path
}

pub(crate) fn create_and_write_keypair(
    key_dir: &Path,
    key_name: &str,
    use_existing_key: bool,
) -> (Keypair, PathBuf) {
    let path = key_dir.join(key_name);

    if use_existing_key {
        if let Ok(file) = File::open(path.clone()) {
            println!("Using existing key at path {}", path.display());
            let keypair_bytes: Vec<u8> = serde_json::from_reader(file).unwrap();
            let keypair = Keypair::from_bytes(&keypair_bytes[..]).unwrap();
            return (keypair, path);
        }
    }

    let keypair = Keypair::new();
    let keypair_json = serde_json::to_string(&keypair.to_bytes()[..]).unwrap();

    let mut file = File::create(path.clone()).expect("Failed to create keypair file");
    file.write_all(keypair_json.as_bytes())
        .expect("Failed to write keypair to file");
    println!("Wrote keypair {} to {}", keypair.pubkey(), path.display());

    (keypair, path)
}

fn build_cmd(cmd: &[&str], wd: Option<&str>, env: Option<&HashMap<&str, &str>>) {
    assert!(!cmd.is_empty(), "Must specify a command!");
    let mut c = Command::new(cmd[0]);
    c.args(&cmd[1..]);
    c.stdout(Stdio::inherit());
    c.stderr(Stdio::inherit());
    if let Some(wd) = wd {
        c.current_dir(wd);
    }
    if let Some(env) = env {
        c.envs(env);
    }
    println!("Running command: {:?}", c);
    let status = c.status().expect("Failed to run command");
    assert!(
        status.success(),
        "Command returned non-zero exit code: {}",
        cmd.join(" ")
    );
}
