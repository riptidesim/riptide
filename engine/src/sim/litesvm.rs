//! LiteSVM-backed `Harness` implementation (in-process SVM).
//!
//! This module replaces the `ValidatorHarness` execution path for
//! hackathon/free CLI runs. The in-process backend removes JSON-RPC and
//! confirmation overhead by running the lending program directly inside
//! a `litesvm::LiteSVM` instance.
//!
//! **Current state**: T01 scaffold + T02 bootstrap + T03 harness ops + T04
//! synthetic chain progression.

use anyhow::{anyhow, Context, Result};
use borsh::BorshDeserialize;
use litesvm::LiteSVM;
use solana_sdk::{
    pubkey::Pubkey,
    signature::{Keypair, Signer},
};
use solana_transaction::Transaction;

use super::harness::{Harness, HarnessError, PoolObservation, PositionObservation};
use crate::{
    harness::{
        lending::{LendingPoolConfig, LendingPoolState, LendingProgramClient, PositionState},
        setup::{
            default_pool_config, default_program_so_path, load_program_bytes,
            ORACLE_STATE_LEN, POOL_STATE_LEN, POSITION_STATE_LEN,
        },
    },
    scenario::OracleUpdate,
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
pub struct LiteSvmHarness {
    svm: LiteSVM,
    pub client: LendingProgramClient,
    pub program_id: Pubkey,
    pub pool: Pubkey,
    pub oracle: Pubkey,
    pub admin: Keypair,
    pub agents: Vec<Keypair>,
    pub positions: Vec<Pubkey>,
    /// Monotonically increasing slot used for synthetic chain progression (T04).
    current_slot: u64,
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

    /// Submit a transaction and classify the result as a `HarnessError`.
    ///
    /// `InstructionError` variants (the program processed the tx and
    /// rejected it) map to `ProgramRejected`. Everything else — blockhash
    /// errors, sanitization failures, signature verification — maps to
    /// `Infra`.
    fn send_harness(
        &mut self,
        payer: &Keypair,
        ix: solana_sdk::instruction::Instruction,
        extra_signer: Option<&Keypair>,
    ) -> Result<(), HarnessError> {
        let blockhash = self.svm.latest_blockhash();
        let mut signers: Vec<&Keypair> = vec![payer];
        if let Some(s) = extra_signer {
            if s.pubkey() != payer.pubkey() {
                signers.push(s);
            }
        }
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&payer.pubkey()),
            &signers,
            blockhash,
        );
        match self.svm.send_transaction(tx) {
            Ok(_) => Ok(()),
            Err(e) => {
                use solana_transaction::TransactionError;
                let msg = format!("{:?}", e.err);
                match e.err {
                    // The program processed the transaction and rejected it.
                    TransactionError::InstructionError(_, _) => {
                        Err(HarnessError::ProgramRejected(msg))
                    }
                    // Everything else is infra: blockhash, signature
                    // verification, sanitization, account-not-found, etc.
                    _ => Err(HarnessError::Infra(msg)),
                }
            }
        }
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
            current_slot: 0,
        })
    }
}

// ---------------------------------------------------------------------------
// Harness trait implementation (T03)
// ---------------------------------------------------------------------------

impl Harness for LiteSvmHarness {
    fn agent_count(&self) -> usize {
        self.agents.len()
    }

    fn advance_tick(&mut self) {
        self.current_slot += 1;
        self.svm.warp_to_slot(self.current_slot);
        self.svm.expire_blockhash();
    }

    fn push_oracle_price(&mut self, update: &OracleUpdate) -> Result<(), HarnessError> {
        let ix = self.client.set_oracle_price(
            self.admin.pubkey(),
            self.oracle,
            update.as_u64(),
            update.exponent,
        );
        self.send_harness(&self.admin.insecure_clone(), ix, None)
    }

    fn observe_pool(&self) -> Result<PoolObservation, HarnessError> {
        let acct = self
            .svm
            .get_account(&self.pool)
            .ok_or_else(|| HarnessError::Infra("pool account not found".into()))?;
        let state = LendingPoolState::try_from_slice(&acct.data)
            .map_err(|e| HarnessError::Infra(format!("pool decode: {e}")))?;
        Ok(PoolObservation {
            total_deposits: state.total_deposits,
            total_borrows: state.total_borrows,
            bad_debt: state.bad_debt,
        })
    }

    fn observe_position(&self, agent_idx: usize) -> Result<PositionObservation, HarnessError> {
        let key = self
            .positions
            .get(agent_idx)
            .ok_or_else(|| HarnessError::Infra(format!("position idx {agent_idx} out of range")))?;
        let acct = self
            .svm
            .get_account(key)
            .ok_or_else(|| HarnessError::Infra(format!("position {agent_idx} not found")))?;
        let state = PositionState::try_from_slice(&acct.data)
            .map_err(|e| HarnessError::Infra(format!("position decode: {e}")))?;
        Ok(PositionObservation {
            collateral: state.collateral,
            debt: state.debt,
            liquidated: state.liquidated,
        })
    }

    fn deposit(&mut self, agent_idx: usize, amount: u64) -> Result<(), HarnessError> {
        let agent = self.agents[agent_idx].insecure_clone();
        let ix = self
            .client
            .deposit(agent.pubkey(), self.pool, self.positions[agent_idx], amount);
        self.send_harness(&agent, ix, None)
    }

    fn withdraw(&mut self, agent_idx: usize, amount: u64) -> Result<(), HarnessError> {
        let agent = self.agents[agent_idx].insecure_clone();
        // Always pass the oracle so the on-chain health-factor check
        // succeeds regardless of whether the position currently has debt.
        let ix = self.client.withdraw(
            agent.pubkey(),
            self.pool,
            self.positions[agent_idx],
            Some(self.oracle),
            amount,
        );
        self.send_harness(&agent, ix, None)
    }

    fn borrow(&mut self, agent_idx: usize, amount: u64) -> Result<(), HarnessError> {
        let agent = self.agents[agent_idx].insecure_clone();
        let ix = self.client.borrow(
            agent.pubkey(),
            self.pool,
            self.positions[agent_idx],
            self.oracle,
            amount,
        );
        self.send_harness(&agent, ix, None)
    }

    fn repay(&mut self, agent_idx: usize, amount: u64) -> Result<(), HarnessError> {
        let agent = self.agents[agent_idx].insecure_clone();
        let ix = self
            .client
            .repay(agent.pubkey(), self.pool, self.positions[agent_idx], amount);
        self.send_harness(&agent, ix, None)
    }

    fn liquidate(
        &mut self,
        liquidator_idx: usize,
        target_idx: usize,
        repay_amount: u64,
    ) -> Result<(), HarnessError> {
        let liquidator = self.agents[liquidator_idx].insecure_clone();
        let ix = self.client.liquidate(
            liquidator.pubkey(),
            self.pool,
            self.positions[target_idx],
            self.positions[liquidator_idx],
            self.oracle,
            repay_amount,
        );
        self.send_harness(&liquidator, ix, None)
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

    fn skip_if_no_so() -> bool {
        let so_path = default_program_so_path();
        if !so_path.exists() {
            eprintln!("skipping: lending_pool.so not found at {}", so_path.display());
            true
        } else {
            false
        }
    }

    // --- T02 bootstrap tests (preserved) ---

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
        if skip_if_no_so() { return; }

        let config = test_config();
        let agent_count = config.agent_count;
        let seed_deposit = config.seed_deposit;
        let harness = LiteSvmHarness::bootstrap(config).unwrap();

        assert_eq!(harness.agents.len(), agent_count);
        assert_eq!(harness.positions.len(), agent_count);

        let oracle_acct = harness.svm.get_account(&harness.oracle)
            .expect("oracle account should exist");
        assert_eq!(oracle_acct.owner, harness.program_id);

        let pool_acct = harness.svm.get_account(&harness.pool)
            .expect("pool account should exist");
        assert_eq!(pool_acct.owner, harness.program_id);

        for (idx, pos_key) in harness.positions.iter().enumerate() {
            let pos_acct = harness.svm.get_account(pos_key)
                .unwrap_or_else(|| panic!("position {idx} should exist"));
            assert_eq!(pos_acct.owner, harness.program_id);
        }

        let pool_state = LendingPoolState::try_from_slice(&pool_acct.data)
            .expect("pool state should deserialize");
        assert!(pool_state.is_initialized);
        assert_eq!(pool_state.total_deposits, seed_deposit * agent_count as u64);
        assert_eq!(pool_state.total_borrows, 0);
    }

    #[test]
    fn bootstrap_positions_have_seeded_collateral() {
        if skip_if_no_so() { return; }

        let config = test_config();
        let seed_deposit = config.seed_deposit;
        let harness = LiteSvmHarness::bootstrap(config).unwrap();

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
        if skip_if_no_so() { return; }

        let config = LiteSvmBootstrapConfig {
            agent_count: 2,
            seed_deposit: 0,
            ..Default::default()
        };
        let harness = LiteSvmHarness::bootstrap(config).unwrap();

        let pool_acct = harness.svm.get_account(&harness.pool).unwrap();
        let pool_state = LendingPoolState::try_from_slice(&pool_acct.data).unwrap();
        assert_eq!(pool_state.total_deposits, 0);
    }

    // --- T03 Harness trait tests ---

    #[test]
    fn harness_agent_count_matches_bootstrap() {
        if skip_if_no_so() { return; }
        let harness = LiteSvmHarness::bootstrap(test_config()).unwrap();
        assert_eq!(harness.agent_count(), 3);
    }

    #[test]
    fn harness_observe_pool_returns_seeded_state() {
        if skip_if_no_so() { return; }
        let harness = LiteSvmHarness::bootstrap(test_config()).unwrap();
        let obs = harness.observe_pool().unwrap();
        assert_eq!(obs.total_deposits, 150); // 3 agents * 50
        assert_eq!(obs.total_borrows, 0);
        assert_eq!(obs.bad_debt, 0);
    }

    #[test]
    fn harness_observe_position_returns_seeded_state() {
        if skip_if_no_so() { return; }
        let harness = LiteSvmHarness::bootstrap(test_config()).unwrap();
        for idx in 0..3 {
            let obs = harness.observe_position(idx).unwrap();
            assert_eq!(obs.collateral, 50);
            assert_eq!(obs.debt, 0);
            assert!(!obs.liquidated);
        }
    }

    #[test]
    fn harness_observe_position_out_of_range_is_infra() {
        if skip_if_no_so() { return; }
        let harness = LiteSvmHarness::bootstrap(test_config()).unwrap();
        let err = harness.observe_position(999).unwrap_err();
        assert!(matches!(err, HarnessError::Infra(_)));
    }

    #[test]
    fn harness_push_oracle_price() {
        if skip_if_no_so() { return; }
        let mut harness = LiteSvmHarness::bootstrap(test_config()).unwrap();
        let update = OracleUpdate { price: 200.0, exponent: 0 };
        harness.push_oracle_price(&update).unwrap();

        // Verify oracle account reflects new price
        let acct = harness.svm.get_account(&harness.oracle).unwrap();
        let oracle = crate::scenario::OracleSnapshot::try_from_slice(&acct.data).unwrap();
        assert_eq!(oracle.price, 200);
    }

    #[test]
    fn harness_deposit_updates_pool_and_position() {
        if skip_if_no_so() { return; }
        let mut harness = LiteSvmHarness::bootstrap(test_config()).unwrap();
        harness.deposit(0, 25).unwrap();

        let pool = harness.observe_pool().unwrap();
        assert_eq!(pool.total_deposits, 175); // 150 seeded + 25 new
        let pos = harness.observe_position(0).unwrap();
        assert_eq!(pos.collateral, 75); // 50 seeded + 25 new
    }

    #[test]
    fn harness_withdraw_updates_pool_and_position() {
        if skip_if_no_so() { return; }
        let mut harness = LiteSvmHarness::bootstrap(test_config()).unwrap();
        harness.withdraw(0, 20).unwrap();

        let pool = harness.observe_pool().unwrap();
        assert_eq!(pool.total_deposits, 130); // 150 - 20
        let pos = harness.observe_position(0).unwrap();
        assert_eq!(pos.collateral, 30); // 50 - 20
    }

    #[test]
    fn harness_borrow_and_repay() {
        if skip_if_no_so() { return; }
        let mut harness = LiteSvmHarness::bootstrap(LiteSvmBootstrapConfig {
            agent_count: 2,
            seed_deposit: 100,
            starting_price: 100,
            ..Default::default()
        }).unwrap();

        // Borrow within LTV
        harness.borrow(0, 10).unwrap();
        let pool = harness.observe_pool().unwrap();
        assert_eq!(pool.total_borrows, 10);
        let pos = harness.observe_position(0).unwrap();
        assert_eq!(pos.debt, 10);

        // Repay
        harness.repay(0, 5).unwrap();
        let pool = harness.observe_pool().unwrap();
        assert_eq!(pool.total_borrows, 5);
        let pos = harness.observe_position(0).unwrap();
        assert_eq!(pos.debt, 5);
    }

    #[test]
    fn harness_borrow_over_ltv_is_program_rejected() {
        if skip_if_no_so() { return; }
        let mut harness = LiteSvmHarness::bootstrap(LiteSvmBootstrapConfig {
            agent_count: 1,
            seed_deposit: 10,
            starting_price: 100,
            ..Default::default()
        }).unwrap();

        // Way over LTV: borrow more than collateral value * ltv
        let err = harness.borrow(0, 999_999).unwrap_err();
        assert!(
            matches!(err, HarnessError::ProgramRejected(_)),
            "expected ProgramRejected, got: {err:?}"
        );
    }

    #[test]
    fn harness_full_lifecycle_deposit_borrow_repay_withdraw() {
        if skip_if_no_so() { return; }
        let mut harness = LiteSvmHarness::bootstrap(LiteSvmBootstrapConfig {
            agent_count: 2,
            seed_deposit: 0,
            starting_price: 100,
            ..Default::default()
        }).unwrap();

        // deposit → borrow → repay → withdraw
        harness.deposit(0, 500).unwrap();
        harness.borrow(0, 10).unwrap();
        harness.repay(0, 10).unwrap();
        harness.withdraw(0, 500).unwrap();

        let pool = harness.observe_pool().unwrap();
        assert_eq!(pool.total_deposits, 0);
        assert_eq!(pool.total_borrows, 0);
        let pos = harness.observe_position(0).unwrap();
        assert_eq!(pos.collateral, 0);
        assert_eq!(pos.debt, 0);
    }

    #[test]
    fn harness_withdraw_with_outstanding_debt_succeeds() {
        if skip_if_no_so() { return; }
        // The on-chain Withdraw instruction conditionally reads the oracle
        // account when position.debt > 0 to re-check the health factor.
        // This test exercises that debt-sensitive path.
        let mut harness = LiteSvmHarness::bootstrap(LiteSvmBootstrapConfig {
            agent_count: 1,
            seed_deposit: 1000,
            starting_price: 100,
            ..Default::default()
        }).unwrap();

        // Borrow a small amount within LTV
        harness.borrow(0, 10).unwrap();
        let pos = harness.observe_position(0).unwrap();
        assert_eq!(pos.debt, 10);

        // Partial withdraw while debt is outstanding — must succeed if the
        // remaining collateral still satisfies the health factor.
        harness.withdraw(0, 100).unwrap();
        let pos = harness.observe_position(0).unwrap();
        assert_eq!(pos.collateral, 900);
        assert_eq!(pos.debt, 10);
    }

    #[test]
    fn harness_withdraw_with_debt_rejected_when_unhealthy() {
        if skip_if_no_so() { return; }
        // Withdraw too much while holding debt → health factor violation.
        let mut harness = LiteSvmHarness::bootstrap(LiteSvmBootstrapConfig {
            agent_count: 1,
            seed_deposit: 100,
            starting_price: 100,
            ..Default::default()
        }).unwrap();

        // Borrow near the LTV cap
        harness.borrow(0, 500).unwrap();

        // Try to withdraw most collateral — should be rejected
        let err = harness.withdraw(0, 99).unwrap_err();
        assert!(
            matches!(err, HarnessError::ProgramRejected(_)),
            "expected ProgramRejected, got: {err:?}"
        );
    }

    // --- T04 Synthetic chain progression tests ---

    #[test]
    fn advance_tick_progresses_slot_and_blockhash() {
        if skip_if_no_so() { return; }
        let mut harness = LiteSvmHarness::bootstrap(LiteSvmBootstrapConfig {
            agent_count: 1,
            seed_deposit: 100,
            ..Default::default()
        }).unwrap();

        let hash_before = harness.svm.latest_blockhash();
        Harness::advance_tick(&mut harness);
        let hash_after = harness.svm.latest_blockhash();
        assert_ne!(hash_before, hash_after, "blockhash should change after advance_tick");
        assert_eq!(harness.current_slot, 1);
    }

    #[test]
    fn operations_succeed_after_multiple_tick_advances() {
        if skip_if_no_so() { return; }
        let mut harness = LiteSvmHarness::bootstrap(LiteSvmBootstrapConfig {
            agent_count: 1,
            seed_deposit: 100,
            starting_price: 100,
            ..Default::default()
        }).unwrap();

        // Simulate several ticks with operations at each — exercises the
        // full tick cadence the real run loop will use.
        for tick in 0..5 {
            Harness::advance_tick(&mut harness);
            let update = OracleUpdate { price: 100.0 + tick as f64, exponent: 0 };
            harness.push_oracle_price(&update).unwrap();
            harness.deposit(0, 10).unwrap();
        }

        let pool = harness.observe_pool().unwrap();
        assert_eq!(pool.total_deposits, 150); // 100 seed + 5*10
        assert_eq!(harness.current_slot, 5);
    }

    #[test]
    fn deterministic_bootstrap_produces_same_accounts() {
        if skip_if_no_so() { return; }
        // Two bootstraps with the same config produce structurally
        // identical environments (different keypairs, but same state).
        let h1 = LiteSvmHarness::bootstrap(test_config()).unwrap();
        let h2 = LiteSvmHarness::bootstrap(test_config()).unwrap();

        let p1 = h1.observe_pool().unwrap();
        let p2 = h2.observe_pool().unwrap();
        assert_eq!(p1, p2);

        for i in 0..3 {
            assert_eq!(
                h1.observe_position(i).unwrap(),
                h2.observe_position(i).unwrap()
            );
        }
    }

    /// Same-seed `run_simulation` on LiteSVM produces identical event
    /// sequences and timeseries — proving T04 determinism on the real
    /// run path, not just isolated tick advances.
    #[test]
    fn same_seed_litesvm_run_is_deterministic() {
        use std::collections::BTreeMap;
        use crate::{
            scenario::BaselineScenario,
            sim::run::{run_simulation, SimulationParams},
            types::{
                Policy, PositionSizing, PositionSizingStrategy,
                RunConfig, SimEvent, Trigger, TriggerCondition,
            },
        };

        if skip_if_no_so() { return; }

        fn make_policy() -> Policy {
            Policy {
                persona_id: "steady-lp".into(),
                persona_label: "steady-lp".into(),
                risk_tolerance: 0.5,
                action_weights: BTreeMap::from([
                    ("deposit".into(), 0.8),
                    ("borrow".into(), 0.1),
                    ("withdraw".into(), 0.05),
                    ("repay".into(), 0.05),
                    ("liquidate".into(), 0.0),
                ]),
                triggers: vec![Trigger {
                    condition: TriggerCondition::PriceDropPercent { threshold: 0.9 },
                    response: "hold".into(),
                    severity: 1,
                    cooldown_ticks: 1,
                }],
                position_sizing: PositionSizing {
                    strategy: PositionSizingStrategy::Fixed,
                    params: BTreeMap::from([("amount".into(), 50.0)]),
                },
                max_exposure: 0.8,
            }
        }

        fn run_once(seed: u64) -> crate::types::SimulationResult {
            let cfg = RunConfig {
                agents: 3,
                ticks: 5,
                scenario: "baseline".into(),
                seed,
                personas: vec!["steady-lp".into()],
                validator_url: "unused".into(),
                output_path: "unused".into(),
            };
            let mut harness = LiteSvmHarness::bootstrap(LiteSvmBootstrapConfig {
                agent_count: 3,
                seed_deposit: 50,
                starting_price: 100,
                ..Default::default()
            }).unwrap();
            let mut scenario = BaselineScenario::new(100.0, 25);
            let policies = vec![make_policy()];
            let params = SimulationParams {
                run_config: &cfg,
                policies,
                agent_personas: vec![0; 3],
                starting_balance: 10_000.0,
                starting_price: 100.0,
                simulation_boundaries: vec!["litesvm".into()],
            };
            run_simulation(&mut harness, &mut scenario, params).unwrap()
        }

        let r1 = run_once(42);
        let r2 = run_once(42);

        let event_keys = |events: &[SimEvent]| -> Vec<(u32, String, String)> {
            events.iter().map(|e| (e.tick, e.agent_id.clone(), e.action.clone())).collect()
        };
        assert_eq!(event_keys(&r1.events), event_keys(&r2.events),
            "event sequences diverged across same-seed LiteSVM runs");

        let tvls = |r: &crate::types::SimulationResult| -> Vec<f64> {
            r.timeseries.iter().map(|s| s.tvl).collect()
        };
        assert_eq!(tvls(&r1), tvls(&r2),
            "timeseries TVL diverged across same-seed LiteSVM runs");

        let prices = |r: &crate::types::SimulationResult| -> Vec<f64> {
            r.timeseries.iter().map(|s| s.oracle_price).collect()
        };
        assert_eq!(prices(&r1), prices(&r2),
            "timeseries oracle_price diverged across same-seed LiteSVM runs");
    }
}
