//! LiteSVM-backed `Harness` implementation (in-process SVM).
//!
//! This module will replace the `ValidatorHarness` execution path for
//! hackathon/free CLI runs. The in-process backend removes JSON-RPC and
//! confirmation overhead by running the lending program directly inside
//! a `litesvm::LiteSVM` instance.
//!
//! **Current state**: T01 scaffold + T02 in-process bootstrap. The `Harness`
//! trait implementation lands in T03.

use anyhow::{anyhow, Context, Result};
use litesvm::LiteSVM;
use solana_sdk::{
    pubkey::Pubkey,
    signature::{Keypair, Signer},
};
use solana_transaction::Transaction;

use crate::harness::{
    lending::{LendingPoolConfig, LendingProgramClient},
    setup::{
        default_pool_config, default_program_so_path, load_program_bytes,
        ORACLE_STATE_LEN, POOL_STATE_LEN, POSITION_STATE_LEN,
    },
};

/// Configuration for bootstrapping a LiteSVM simulation environment.
pub struct LiteSvmBootstrapConfig {
    /// Path to the compiled `lending_pool.so` artifact.
    pub program_so: std::path::PathBuf,
    /// Number of agent positions to create.
    pub agent_count: usize,
    /// Oracle starting price (raw integer, e.g. 100).
    pub starting_price: u64,
    /// Oracle price exponent (e.g. 0 for integer prices, -2 for cents).
    pub price_exponent: i8,
    /// Lending pool configuration.
    pub pool_config: LendingPoolConfig,
    /// Initial deposit amount seeded per agent position.
    pub seed_deposit: u64,
}

impl Default for LiteSvmBootstrapConfig {
    fn default() -> Self {
        Self {
            program_so: default_program_so_path(),
            agent_count: 10,
            starting_price: 100,
            price_exponent: 0,
            pool_config: default_pool_config(),
            seed_deposit: 100,
        }
    }
}

/// Wraps a `LiteSVM` instance and the account keys needed by the tick loop.
///
/// The `Harness` trait implementation is deferred to T03.
pub struct LiteSvmHarness {
    svm: LiteSVM,
    pub client: LendingProgramClient,
    pub program_id: Pubkey,
    pub pool: Pubkey,
    pub oracle: Pubkey,
    pub admin: Keypair,
    pub agents: Vec<Keypair>,
    pub positions: Vec<Pubkey>,
}

impl LiteSvmHarness {
    /// Submit a signed transaction through the in-process SVM.
    /// Signature verification and blockhash checks are enforced.
    pub(crate) fn send_transaction(
        &mut self,
        payer: &Keypair,
        instructions: Vec<solana_sdk::instruction::Instruction>,
        signers: &[&Keypair],
    ) -> Result<()> {
        send_tx(&mut self.svm, payer, instructions, signers)
    }
}

impl LiteSvmHarness {
    /// Bootstrap a fully initialized LiteSVM environment in-process.
    ///
    /// This replaces the validator-backed bootstrap in `main.rs` for the
    /// LiteSVM path. All account creation, program loading, and state seeding
    /// happen through direct LiteSVM APIs — no RPC round-trips, no
    /// `solana program deploy`.
    ///
    /// On success, the returned harness has:
    /// - The lending program loaded
    /// - Admin and agents funded
    /// - Oracle initialized at `config.starting_price`
    /// - Pool initialized with `config.pool_config`
    /// - One position account per agent, each seeded with `config.seed_deposit`
    pub fn bootstrap(config: LiteSvmBootstrapConfig) -> Result<Self> {
        // --- Load and validate the program artifact ---
        let program_bytes = load_program_bytes(&config.program_so)?;

        // --- Stand up LiteSVM with builtins and sysvars ---
        // Signature verification and blockhash checks stay ON (the defaults)
        // so the in-process path exercises the same auth/replay checks the
        // on-chain program expects. All transactions are properly signed.
        let mut svm = LiteSVM::new()
            .with_builtins()
            .with_sysvars()
            .with_lamports(1_000_000_000_000);

        // --- Load the lending program ---
        let program_id = Pubkey::new_unique();
        svm.add_program(program_id, &program_bytes)
            .map_err(|e| anyhow!("failed to load lending program into LiteSVM: {e}"))?;

        let client = LendingProgramClient::new(program_id);

        // --- Create and fund identities ---
        let admin = Keypair::new();
        airdrop(&mut svm, &admin.pubkey(), 10_000_000_000)?;

        let agents: Vec<Keypair> = (0..config.agent_count).map(|_| Keypair::new()).collect();
        for agent in &agents {
            airdrop(&mut svm, &agent.pubkey(), 10_000_000_000)?;
        }

        // --- Create oracle + pool accounts and initialize via program ---
        let oracle_kp = Keypair::new();
        let pool_kp = Keypair::new();

        let rent_oracle = svm.minimum_balance_for_rent_exemption(ORACLE_STATE_LEN);
        let rent_pool = svm.minimum_balance_for_rent_exemption(POOL_STATE_LEN);

        let create_and_init_ix = vec![
            crate::harness::setup::create_program_account(
                &admin.pubkey(),
                &oracle_kp.pubkey(),
                &program_id,
                rent_oracle,
                ORACLE_STATE_LEN,
            ),
            crate::harness::setup::create_program_account(
                &admin.pubkey(),
                &pool_kp.pubkey(),
                &program_id,
                rent_pool,
                POOL_STATE_LEN,
            ),
            client.initialize_oracle(
                admin.pubkey(),
                oracle_kp.pubkey(),
                config.starting_price,
                config.price_exponent,
            ),
            client.initialize_pool(
                admin.pubkey(),
                pool_kp.pubkey(),
                oracle_kp.pubkey(),
                config.pool_config,
            ),
        ];
        send_tx(&mut svm, &admin, create_and_init_ix, &[&admin, &oracle_kp, &pool_kp])
            .context("oracle + pool initialization")?;

        // --- Create position accounts per agent ---
        let rent_position = svm.minimum_balance_for_rent_exemption(POSITION_STATE_LEN);
        let mut position_pubkeys = Vec::with_capacity(config.agent_count);
        for _agent_idx in 0..config.agent_count {
            let pos_kp = Keypair::new();
            let ix = crate::harness::setup::create_program_account(
                &admin.pubkey(),
                &pos_kp.pubkey(),
                &program_id,
                rent_position,
                POSITION_STATE_LEN,
            );
            send_tx(&mut svm, &admin, vec![ix], &[&admin, &pos_kp])
                .context("create position account")?;
            position_pubkeys.push(pos_kp.pubkey());
        }

        // --- Seed initial deposits ---
        if config.seed_deposit > 0 {
            for (idx, agent) in agents.iter().enumerate() {
                let ix = client.deposit(
                    agent.pubkey(),
                    pool_kp.pubkey(),
                    position_pubkeys[idx],
                    config.seed_deposit,
                );
                send_tx(&mut svm, agent, vec![ix], &[agent])
                    .with_context(|| format!("seed deposit for agent {idx}"))?;
            }
        }

        Ok(Self {
            svm,
            client,
            program_id,
            pool: pool_kp.pubkey(),
            oracle: oracle_kp.pubkey(),
            admin,
            agents,
            positions: position_pubkeys,
        })
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Airdrop lamports to an address in LiteSVM.
fn airdrop(svm: &mut LiteSVM, address: &Pubkey, lamports: u64) -> Result<()> {
    svm.airdrop(address, lamports)
        .map_err(|e| anyhow!("airdrop to {address}: {e:?}"))
        .map(|_| ())
}

/// Build, sign, and send a transaction through LiteSVM.
fn send_tx(
    svm: &mut LiteSVM,
    payer: &Keypair,
    instructions: Vec<solana_sdk::instruction::Instruction>,
    signers: &[&Keypair],
) -> Result<()> {
    let blockhash = svm.latest_blockhash();
    let tx = Transaction::new_signed_with_payer(
        &instructions,
        Some(&payer.pubkey()),
        signers,
        blockhash,
    );
    svm.send_transaction(tx)
        .map_err(|e| anyhow!("transaction failed: {e:?}"))
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> LiteSvmBootstrapConfig {
        LiteSvmBootstrapConfig {
            agent_count: 3,
            seed_deposit: 50,
            ..Default::default()
        }
    }

    #[test]
    fn bootstrap_fails_fast_on_missing_program() {
        let config = LiteSvmBootstrapConfig {
            program_so: "/nonexistent/lending_pool.so".into(),
            ..Default::default()
        };
        match LiteSvmHarness::bootstrap(config) {
            Ok(_) => panic!("expected error for missing .so"),
            Err(e) => {
                let msg = e.to_string();
                assert!(msg.contains("lending_pool.so not found"), "got: {msg}");
            }
        }
    }

    #[test]
    fn bootstrap_creates_initialized_environment() {
        let so_path = default_program_so_path();
        if !so_path.exists() {
            eprintln!("skipping: lending_pool.so not found at {}", so_path.display());
            return;
        }

        let config = test_config();
        let agent_count = config.agent_count;
        let seed_deposit = config.seed_deposit;
        let harness = LiteSvmHarness::bootstrap(config).unwrap();

        // Correct number of agents and positions
        assert_eq!(harness.agents.len(), agent_count);
        assert_eq!(harness.positions.len(), agent_count);

        // Oracle account exists and is owned by the program
        let oracle_acct = harness.svm.get_account(&harness.oracle)
            .expect("oracle account should exist");
        assert_eq!(oracle_acct.owner, harness.program_id);

        // Pool account exists and is owned by the program
        let pool_acct = harness.svm.get_account(&harness.pool)
            .expect("pool account should exist");
        assert_eq!(pool_acct.owner, harness.program_id);

        // Each position account exists and is owned by the program
        for (idx, pos_key) in harness.positions.iter().enumerate() {
            let pos_acct = harness.svm.get_account(pos_key)
                .unwrap_or_else(|| panic!("position {idx} should exist"));
            assert_eq!(pos_acct.owner, harness.program_id);
        }

        // Pool state reflects seeded deposits
        use borsh::BorshDeserialize;
        use crate::harness::lending::LendingPoolState;
        let pool_data = &pool_acct.data;
        let pool_state = LendingPoolState::try_from_slice(pool_data)
            .expect("pool state should deserialize");
        assert!(pool_state.is_initialized);
        assert_eq!(pool_state.total_deposits, seed_deposit * agent_count as u64);
        assert_eq!(pool_state.total_borrows, 0);
    }

    #[test]
    fn bootstrap_positions_have_seeded_collateral() {
        let so_path = default_program_so_path();
        if !so_path.exists() {
            eprintln!("skipping: lending_pool.so not found");
            return;
        }

        let config = test_config();
        let seed_deposit = config.seed_deposit;
        let harness = LiteSvmHarness::bootstrap(config).unwrap();

        use borsh::BorshDeserialize;
        use crate::harness::lending::PositionState;
        for (idx, pos_key) in harness.positions.iter().enumerate() {
            let acct = harness.svm.get_account(pos_key).unwrap();
            let state = PositionState::try_from_slice(&acct.data)
                .unwrap_or_else(|e| panic!("position {idx} decode: {e}"));
            assert_eq!(state.collateral, seed_deposit, "agent {idx} collateral mismatch");
            assert_eq!(state.debt, 0);
            assert!(!state.liquidated);
        }
    }

    #[test]
    fn bootstrap_zero_seed_deposit_skips_deposits() {
        let so_path = default_program_so_path();
        if !so_path.exists() {
            eprintln!("skipping: lending_pool.so not found");
            return;
        }

        let config = LiteSvmBootstrapConfig {
            agent_count: 2,
            seed_deposit: 0,
            ..Default::default()
        };
        let harness = LiteSvmHarness::bootstrap(config).unwrap();

        use borsh::BorshDeserialize;
        use crate::harness::lending::LendingPoolState;
        let pool_acct = harness.svm.get_account(&harness.pool).unwrap();
        let pool_state = LendingPoolState::try_from_slice(&pool_acct.data).unwrap();
        assert_eq!(pool_state.total_deposits, 0);
    }
}
