use std::{
    path::{Path, PathBuf},
    process::Command,
    str::FromStr,
};

use anyhow::{anyhow, Context, Result};
use borsh::to_vec;
use solana_sdk::{
    instruction::Instruction,
    pubkey::Pubkey,
    signature::{read_keypair_file, Keypair, Signer},
};
use solana_system_interface::instruction as system_instruction;

use super::lending::{LendingPoolConfig, LendingPoolState, PositionState};
use crate::scenario::OracleSnapshot;

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

// ---------------------------------------------------------------------------
// In-process bootstrap helpers (LiteSVM path)
// ---------------------------------------------------------------------------

/// Read the compiled program artifact from disk. Fails fast with a clear
/// rebuild instruction if the file is missing or unreadable.
pub fn load_program_bytes(so_path: &Path) -> Result<Vec<u8>> {
    if !so_path.exists() {
        return Err(anyhow!(
            "lending_pool.so not found at {}\n\
             Run:  cd riptide-monorepo/programs/lending_pool && cargo build-sbf\n\
             then retry the simulation.",
            so_path.display()
        ));
    }
    std::fs::read(so_path).with_context(|| format!("failed to read {}", so_path.display()))
}

/// Serialize a `LendingPoolState` into the raw bytes an in-process account
/// would hold. The caller is responsible for creating the actual account
/// (e.g. via `LiteSVM::set_account`).
pub fn serialize_pool_state(state: &LendingPoolState) -> Vec<u8> {
    to_vec(state).expect("LendingPoolState borsh serialization should never fail")
}

/// Serialize a `PositionState` into raw account bytes.
pub fn serialize_position_state(state: &PositionState) -> Vec<u8> {
    to_vec(state).expect("PositionState borsh serialization should never fail")
}

/// Serialize an `OracleSnapshot` into raw account bytes.
pub fn serialize_oracle_state(state: &OracleSnapshot) -> Vec<u8> {
    to_vec(state).expect("OracleSnapshot borsh serialization should never fail")
}

/// Build a fresh, initialized `LendingPoolState` owned by `admin` with the
/// given oracle key and pool config. All counters start at zero.
pub fn initial_pool_state(admin: &Pubkey, oracle: &Pubkey, config: &LendingPoolConfig) -> LendingPoolState {
    LendingPoolState {
        is_initialized: true,
        admin: admin.to_bytes(),
        oracle: oracle.to_bytes(),
        total_deposits: 0,
        total_borrows: 0,
        bad_debt: 0,
        ltv_bps: config.ltv_bps,
        liquidation_threshold_bps: config.liquidation_threshold_bps,
        liquidation_bonus_bps: config.liquidation_bonus_bps,
        interest_bps: config.interest_bps,
        deposit_limit: config.deposit_limit,
        borrow_limit: config.borrow_limit,
    }
}

/// Build a fresh, initialized `OracleSnapshot` owned by `admin` with the
/// given starting price.
pub fn initial_oracle_state(admin: &Pubkey, price: u64, exponent: i8) -> OracleSnapshot {
    OracleSnapshot {
        is_initialized: true,
        admin: admin.to_bytes(),
        price,
        exponent,
        reserved: [0; 8],
    }
}

/// Build a fresh, zero-balance position owned by `owner`.
pub fn initial_position_state(owner: &Pubkey) -> PositionState {
    PositionState {
        owner: owner.to_bytes(),
        collateral: 0,
        debt: 0,
        liquidated: false,
    }
}

// ---------------------------------------------------------------------------

pub fn parse_pubkey(value: &str) -> Result<Pubkey> {
    Pubkey::from_str(value).map_err(|error| anyhow!(error))
}

#[cfg(test)]
mod tests {
    use borsh::{to_vec, BorshDeserialize};

    use super::*;

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

    // --- in-process bootstrap helpers ---

    #[test]
    fn load_program_bytes_fails_fast_on_missing_so() {
        let err = load_program_bytes(Path::new("/nonexistent/lending_pool.so")).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("lending_pool.so not found"), "got: {msg}");
        assert!(msg.contains("cargo build-sbf"), "missing rebuild hint: {msg}");
    }

    #[test]
    fn load_program_bytes_reads_existing_artifact() {
        let path = default_program_so_path();
        if path.exists() {
            let bytes = load_program_bytes(&path).unwrap();
            assert!(!bytes.is_empty());
        }
        // If the .so doesn't exist in CI, skip rather than fail.
    }

    #[test]
    fn serialize_pool_state_roundtrips() {
        let admin = Pubkey::new_unique();
        let oracle = Pubkey::new_unique();
        let config = default_pool_config();
        let state = initial_pool_state(&admin, &oracle, &config);
        let bytes = serialize_pool_state(&state);
        assert_eq!(bytes.len(), POOL_STATE_LEN);
        let decoded = LendingPoolState::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded.admin, admin.to_bytes());
        assert_eq!(decoded.ltv_bps, config.ltv_bps);
    }

    #[test]
    fn serialize_position_state_roundtrips() {
        let owner = Pubkey::new_unique();
        let state = initial_position_state(&owner);
        let bytes = serialize_position_state(&state);
        assert_eq!(bytes.len(), POSITION_STATE_LEN);
        let decoded = PositionState::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded.owner, owner.to_bytes());
        assert_eq!(decoded.collateral, 0);
    }

    #[test]
    fn serialize_oracle_state_roundtrips() {
        let admin = Pubkey::new_unique();
        let state = initial_oracle_state(&admin, 10_000, -2);
        let bytes = serialize_oracle_state(&state);
        assert_eq!(bytes.len(), ORACLE_STATE_LEN);
        let decoded = OracleSnapshot::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded.price, 10_000);
        assert_eq!(decoded.exponent, -2);
    }

    #[test]
    fn initial_pool_state_uses_config_values() {
        let admin = Pubkey::new_unique();
        let oracle = Pubkey::new_unique();
        let config = LendingPoolConfig {
            ltv_bps: 5_000,
            liquidation_threshold_bps: 7_500,
            liquidation_bonus_bps: 300,
            interest_bps: 100,
            deposit_limit: 500_000,
            borrow_limit: 250_000,
        };
        let state = initial_pool_state(&admin, &oracle, &config);
        assert!(state.is_initialized);
        assert_eq!(state.ltv_bps, 5_000);
        assert_eq!(state.deposit_limit, 500_000);
        assert_eq!(state.total_deposits, 0);
    }
}
