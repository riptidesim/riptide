use std::{
    path::{Path, PathBuf},
    process::Command,
    str::FromStr,
};

use anyhow::{anyhow, Context, Result};
use solana_sdk::{
    instruction::Instruction,
    pubkey::Pubkey,
    signature::{read_keypair_file, Keypair, Signer},
};
use solana_system_interface::instruction as system_instruction;

use super::lending::{LendingPoolConfig, LendingPoolState, PositionState};

pub const POOL_STATE_LEN: usize = 113;
pub const POSITION_STATE_LEN: usize = 49;
pub const ORACLE_STATE_LEN: usize = 50;
pub const PROGRAM_SO_RELATIVE_PATH: &str = "programs/lending_pool/target/deploy/lending_pool.so";

#[derive(Debug)]
pub struct HarnessAccounts {
    pub admin: Keypair,
    pub pool: Keypair,
    pub oracle: Keypair,
}

#[derive(Debug, Clone)]
pub struct HarnessDeployment {
    pub program_id: Pubkey,
    pub program_keypair_path: PathBuf,
}

pub fn deploy_program(
    program_so: &Path,
    rpc_url: &str,
    payer_path: &Path,
) -> Result<HarnessDeployment> {
    let solana_path = which::which("solana").context("solana CLI not found in PATH")?;
    let keypair_path = program_so
        .parent()
        .and_then(|parent| parent.parent())
        .map(|parent| parent.join("deploy").join("lending_pool-keypair.json"))
        .ok_or_else(|| anyhow!("unable to infer deploy keypair path"))?;
    let program_keypair = read_keypair_file(&keypair_path)
        .map_err(|error| anyhow!("failed to read {}: {}", keypair_path.display(), error))?;

    let output = Command::new(solana_path)
        .arg("program")
        .arg("deploy")
        .arg(program_so)
        .arg("--program-id")
        .arg(&keypair_path)
        .arg("--url")
        .arg(rpc_url)
        .arg("--keypair")
        .arg(payer_path)
        .output()
        .context("failed to invoke solana program deploy")?;

    if !output.status.success() {
        return Err(anyhow!(
            "program deploy failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    Ok(HarnessDeployment {
        program_id: program_keypair.pubkey(),
        program_keypair_path: keypair_path,
    })
}

pub fn default_program_so_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(PROGRAM_SO_RELATIVE_PATH)
}

pub fn create_program_account(
    payer: &Pubkey,
    account: &Pubkey,
    owner: &Pubkey,
    lamports: u64,
    space: usize,
) -> Instruction {
    system_instruction::create_account(payer, account, lamports, space as u64, owner)
}

pub fn default_pool_config() -> LendingPoolConfig {
    LendingPoolConfig {
        ltv_bps: 6_500,
        liquidation_threshold_bps: 8_000,
        liquidation_bonus_bps: 500,
        interest_bps: 250,
        deposit_limit: 1_000_000,
        borrow_limit: 750_000,
    }
}

pub fn placeholder_state() -> (LendingPoolState, PositionState) {
    (
        LendingPoolState {
            is_initialized: true,
            admin: [0; 32],
            oracle: [0; 32],
            total_deposits: 0,
            total_borrows: 0,
            bad_debt: 0,
            ltv_bps: 6_500,
            liquidation_threshold_bps: 8_000,
            liquidation_bonus_bps: 500,
            interest_bps: 250,
            deposit_limit: 1_000_000,
            borrow_limit: 750_000,
        },
        PositionState::default(),
    )
}

pub fn parse_pubkey(value: &str) -> Result<Pubkey> {
    Pubkey::from_str(value).map_err(|error| anyhow!(error))
}

#[cfg(test)]
mod tests {
    use borsh::to_vec;

    use super::*;
    use crate::scenario::OracleSnapshot;

    #[test]
    fn serialized_account_sizes_match_constants() {
        let (pool, position) = placeholder_state();
        let oracle = OracleSnapshot {
            is_initialized: true,
            admin: [0; 32],
            price: 100,
            exponent: 0,
            reserved: [0; 8],
        };

        assert_eq!(to_vec(&pool).unwrap().len(), POOL_STATE_LEN);
        assert_eq!(to_vec(&position).unwrap().len(), POSITION_STATE_LEN);
        assert_eq!(to_vec(&oracle).unwrap().len(), ORACLE_STATE_LEN);
    }

    #[test]
    fn default_program_path_is_anchored_to_workspace() {
        assert!(default_program_so_path().ends_with(PROGRAM_SO_RELATIVE_PATH));
    }
}
