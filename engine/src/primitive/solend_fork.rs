//! Solend-fork lending primitive implementation, backed by in-process
//! LiteSVM.
//!
//! This is the first `LendingPrimitive` impl. It wraps a
//! `litesvm::LiteSVM` instance, the forked Solend lending program
//! (`lending_pool.so`), and one position account per simulated agent.
//! Protocol-specific wiring (`LendingProgramClient`, account layouts,
//! instruction selectors) lives inside this module — the rest of the
//! engine reaches it only through the `LendingPrimitive` and `Harness`
//! traits. A sibling `primitive/generic.rs` handles non-lending programs
//! driven by adapter TOML.

use anyhow::{anyhow, Context, Result};
use borsh::BorshDeserialize;
use litesvm::LiteSVM;
use solana_sdk::{
    pubkey::Pubkey,
    signature::{Keypair, Signer},
};
use solana_transaction::Transaction;

use crate::{
    adapter::{Adapter, OracleKind},
    harness::{
        lending::{LendingPoolConfig, LendingPoolState, LendingProgramClient, PositionState},
        setup::{
            default_pool_config, default_program_so_path, load_program_bytes,
            ORACLE_STATE_LEN, POOL_STATE_LEN, POSITION_STATE_LEN,
        },
    },
    primitive::{LendingPrimitive, PoolState, PositionHealth, PrimitiveError},
    scenario::{oracle_layout_for, OracleUpdate},
};

/// Configuration for bootstrapping a LiteSVM-backed Solend-fork primitive.
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
    /// Optional adapter configuration. When present, the primitive
    /// validates at bootstrap time that the adapter's `[instructions]`
    /// and `[state_mapping]` match the Solend-fork's expected wiring.
    /// A scrambled adapter fails bootstrap before any on-chain state
    /// is touched.
    pub adapter: Option<Adapter>,
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
            adapter: None,
        }
    }
}

/// Solend-fork's expected `[instructions]` wiring. Each tuple is
/// (instruction name, required `action` field value). The primitive
/// rejects any adapter whose shape diverges from this list.
const EXPECTED_INSTRUCTIONS: &[(&str, &str)] = &[
    ("deposit", "deposit"),
    ("borrow", "borrow"),
    ("repay", "repay"),
    ("withdraw", "withdraw"),
    ("liquidate", "liquidate"),
];

/// Solend-fork's expected `[state_mapping]` wiring. Each tuple is
/// (`<account>.<field>` dotted path, required logical observation
/// name). The primitive rejects any adapter whose shape diverges.
const EXPECTED_STATE_MAPPING: &[(&str, &str)] = &[
    ("pool.total_deposits", "tvl"),
    ("pool.total_borrows", "debt"),
    ("pool.bad_debt", "bad_debt"),
    ("position.collateral", "collateral"),
    ("position.debt", "debt"),
    ("position.liquidated", "liquidated"),
];

/// Validate that an adapter matches the Solend-fork's hardcoded
/// instruction/state wiring. Called from `bootstrap` when the adapter
/// is supplied. Returns an error that identifies the first divergence.
fn validate_adapter_for_solend_fork(adapter: &Adapter) -> Result<()> {
    for (ix_name, expected_action) in EXPECTED_INSTRUCTIONS {
        let mapping = adapter.instructions.get(*ix_name).ok_or_else(|| {
            anyhow!(
                "solend-fork primitive: adapter [instructions] missing required key `{}`",
                ix_name
            )
        })?;
        if mapping.action != *expected_action {
            return Err(anyhow!(
                "solend-fork primitive: adapter [instructions].{}.action must be `{}`, got `{}`",
                ix_name,
                expected_action,
                mapping.action
            ));
        }
    }
    for (path, expected_obs) in EXPECTED_STATE_MAPPING {
        let obs = adapter.state_mapping.get(*path).ok_or_else(|| {
            anyhow!(
                "solend-fork primitive: adapter [state_mapping] missing required key `{}`",
                path
            )
        })?;
        if obs != expected_obs {
            return Err(anyhow!(
                "solend-fork primitive: adapter [state_mapping].`{}` must be `{}`, got `{}`",
                path,
                expected_obs,
                obs
            ));
        }
    }
    Ok(())
}

/// Solend-fork lending primitive, executed in-process on LiteSVM.
///
/// Holds the SVM instance, the deployed program id, the admin/agent
/// keypairs, and the oracle / pool / per-agent position account keys.
/// All state-changing operations go through signed LiteSVM transactions.
pub struct LiteSvmHarness {
    pub(crate) svm: LiteSVM,
    pub client: LendingProgramClient,
    pub program_id: Pubkey,
    pub pool: Pubkey,
    pub oracle: Pubkey,
    pub admin: Keypair,
    pub agents: Vec<Keypair>,
    pub positions: Vec<Pubkey>,
    /// Monotonically increasing slot used for synthetic chain progression.
    current_slot: u64,
    /// Last oracle price observed by `push_oracle_price`, cached so
    /// `snapshot_metrics` can emit an `oracle_price` column without
    /// re-reading the oracle account every tick. Initialized to the
    /// bootstrap starting price.
    last_oracle_price: f64,
    /// oracle layout kind selected from the adapter's
    /// `[[oracles]]` block. `push_oracle_price` uses
    /// [`oracle_layout_for`] to decode the post-update account bytes
    /// and verify they match the requested (price, exponent) pair —
    /// this is what makes the declared kind load-bearing at runtime.
    /// Defaults to `AdminMock` when the adapter declares no oracles
    /// (preserves the hero-grid determinism path).
    oracle_kind: OracleKind,
}

impl LiteSvmHarness {
    /// Submit a transaction and classify the result as a `PrimitiveError`.
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
    ) -> Result<(), PrimitiveError> {
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
                        Err(PrimitiveError::ProgramRejected(msg))
                    }
                    // Everything else is infra: blockhash, signature
                    // verification, sanitization, account-not-found, etc.
                    _ => Err(PrimitiveError::Infra(msg)),
                }
            }
        }
    }
}

impl LiteSvmHarness {
    /// Bootstrap a fully initialized LiteSVM environment in-process.
    ///
    /// All account creation, program loading, and state seeding happen
    /// through direct LiteSVM APIs — no RPC round-trips, no
    /// `solana program deploy`.
    ///
    /// On success, the returned harness has:
    /// - The lending program loaded
    /// - Admin and agents funded
    /// - Oracle initialized at `config.starting_price`
    /// - Pool initialized with `config.pool_config`
    /// - One position account per agent, each seeded with `config.seed_deposit`
    pub fn bootstrap(config: LiteSvmBootstrapConfig) -> Result<Self> {
        // --- Validate the adapter contract (if present) BEFORE touching
        // any on-chain state, so a scrambled adapter fails fast rather
        // than producing a misleading mid-bootstrap error. ---
        if let Some(adapter) = config.adapter.as_ref() {
            validate_adapter_for_solend_fork(adapter)
                .context("adapter validation failed at bootstrap")?;
        }

        // --- Load and validate the program artifact ---
        let program_bytes = load_program_bytes(&config.program_so)?;

        // --- Stand up LiteSVM with builtins and sysvars ---
        // Signature verification and blockhash checks stay ON (the defaults)
        // so the in-process path exercises the same auth/replay checks the
        // on-chain program expects. All transactions are properly signed.
        let per_identity_lamports: u64 = 10_000_000_000; // 10 SOL
        let identity_count = (config.agent_count as u64) + 1; // agents + admin
        let base_lamports = identity_count * per_identity_lamports * 2; // 2x headroom for rent + fees
        let mut svm = LiteSVM::new()
            .with_builtins()
            .with_sysvars()
            .with_lamports(base_lamports);

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

        let starting_oracle_price = if config.price_exponent < 0 {
            (config.starting_price as f64)
                / 10f64.powi(i32::from(-config.price_exponent))
        } else {
            (config.starting_price as f64)
                * 10f64.powi(i32::from(config.price_exponent))
        };

        // select the oracle layout kind from the
        // adapter's `[[oracles]]` block. An adapter with no declared
        // oracles (e.g. the shipped solend-fork.toml) keeps
        // the `AdminMock` default, which is byte-identical to the
        // layout the on-chain program already writes — so the hero
        // grid's determinism hash stays byte-stable.
        let oracle_kind = config
            .adapter
            .as_ref()
            .and_then(|a| a.oracles.first().map(|o| o.kind))
            .unwrap_or(OracleKind::AdminMock);

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
            last_oracle_price: starting_oracle_price,
            oracle_kind,
        })
    }
}

// ---------------------------------------------------------------------------
// LendingPrimitive impl — owns every method body.
//
// `sim::harness::Harness` is a re-export alias of `LendingPrimitive`, so
// this single impl covers both trait names. There is no parallel
// `impl Harness for LiteSvmHarness`; deleting this block or changing
// any method body here changes the tick loop's behavior directly.
// ---------------------------------------------------------------------------

impl crate::primitive::Primitive for LiteSvmHarness {
    fn agent_count(&self) -> usize {
        self.agents.len()
    }

    fn advance_tick(&mut self) {
        self.current_slot += 1;
        self.svm.warp_to_slot(self.current_slot);
        self.svm.expire_blockhash();
    }

    fn push_oracle_price(&mut self, update: &OracleUpdate) -> Result<(), PrimitiveError> {
        let ix = self.client.set_oracle_price(
            self.admin.pubkey(),
            self.oracle,
            update.as_u64(),
            update.exponent,
        );
        self.send_harness(&self.admin.insecure_clone(), ix, None)?;

        // verify the post-update oracle account bytes
        // are byte-identical to what `oracle_layout_for(self.oracle_kind)`
        // produces. This is the load-bearing call site for the layout
        // dispatch — every lending run consults it, and a layout drift
        // / kind mismatch surfaces as an Infra failure on the next tick.
        // Declaring `[[oracles]] kind = "..."` on an adapter has a real
        // runtime effect: it selects which layout encodes the expected
        // byte shape AND which decoder validates every on-chain write.
        //
        // Byte-level comparison (not float-level) is load-bearing: the
        // on-chain `SetOraclePrice` ix takes `price: u64`, quantizing
        // the scenario's f64 price via `update.as_u64()`. Comparing
        // the decoded float back against the original float would
        // catch that quantization as a drift. The correct contract
        // is: "given the same admin + quantized update, the on-chain
        // program and the engine-side layout produce identical bytes".
        let layout = oracle_layout_for(self.oracle_kind);
        let account = self
            .svm
            .get_account(&self.oracle)
            .ok_or_else(|| PrimitiveError::Infra("oracle account missing after push".into()))?;
        // Sanity-check the decode path actually resolves cleanly.
        let _decoded = layout.decode(&account.data).map_err(|e| {
            PrimitiveError::Infra(format!(
                "oracle layout `{:?}` failed to decode post-update bytes: {e}",
                self.oracle_kind
            ))
        })?;
        let expected_bytes = layout
            .encode(self.admin.pubkey().to_bytes(), update)
            .map_err(|e| {
                PrimitiveError::Infra(format!(
                    "oracle layout `{:?}` encode failed: {e}",
                    self.oracle_kind
                ))
            })?;
        if account.data.len() < expected_bytes.len()
            || account.data[..expected_bytes.len()] != expected_bytes[..]
        {
            return Err(PrimitiveError::Infra(format!(
                "oracle layout `{:?}` post-update bytes diverged from engine \
                 encode (on-chain vs engine-side layout mirror drifted)",
                self.oracle_kind
            )));
        }

        self.last_oracle_price = update.price;
        Ok(())
    }

    fn snapshot_metrics(
        &self,
    ) -> Result<std::collections::BTreeMap<String, serde_json::Value>, PrimitiveError> {
        use crate::primitive::LendingPrimitive;
        let pool = <Self as LendingPrimitive>::pool_state(self)?;
        let mut metrics = std::collections::BTreeMap::new();
        metrics.insert("tvl".into(), json_f64(pool.total_deposits as f64));
        metrics.insert("utilization".into(), json_f64(pool.utilization()));
        metrics.insert("oracle_price".into(), json_f64(self.last_oracle_price));
        metrics.insert("cumulative_bad_debt".into(), json_f64(pool.bad_debt as f64));
        Ok(metrics)
    }

    fn summarize_metrics(
        &self,
        timeseries: &[crate::types::TickSnapshot],
    ) -> Result<std::collections::BTreeMap<String, serde_json::Value>, PrimitiveError> {
        use crate::primitive::LendingPrimitive;
        let pool = <Self as LendingPrimitive>::pool_state(self)?;

        // Largest single-tick oracle drawdown across the timeseries.
        let mut largest_drawdown: f64 = 0.0;
        for pair in timeseries.windows(2) {
            let prev = pair[0].get("oracle_price").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let next = pair[1].get("oracle_price").and_then(|v| v.as_f64()).unwrap_or(0.0);
            if prev > 0.0 {
                let drop = ((prev - next) / prev).max(0.0);
                if drop > largest_drawdown {
                    largest_drawdown = drop;
                }
            }
        }

        let mut summary = std::collections::BTreeMap::new();
        summary.insert("final_tvl".into(), json_f64(pool.total_deposits as f64));
        summary.insert("final_utilization".into(), json_f64(pool.utilization()));
        summary.insert("total_bad_debt".into(), json_f64(pool.bad_debt as f64));
        summary.insert(
            "largest_single_tick_drawdown".into(),
            json_f64(largest_drawdown),
        );
        Ok(summary)
    }

    fn execute_action(
        &mut self,
        agent_idx: usize,
        action: &str,
        amount: u64,
        target_idx: Option<usize>,
    ) -> Result<(), PrimitiveError> {
        crate::primitive::dispatch_lending_action(self, agent_idx, action, amount, target_idx)
    }
}

impl LendingPrimitive for LiteSvmHarness {
    fn deposit(&mut self, agent_idx: usize, amount: u64) -> Result<(), PrimitiveError> {
        let agent = self.agents[agent_idx].insecure_clone();
        let ix = self
            .client
            .deposit(agent.pubkey(), self.pool, self.positions[agent_idx], amount);
        self.send_harness(&agent, ix, None)
    }

    fn withdraw(&mut self, agent_idx: usize, amount: u64) -> Result<(), PrimitiveError> {
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

    fn borrow(&mut self, agent_idx: usize, amount: u64) -> Result<(), PrimitiveError> {
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

    fn repay(&mut self, agent_idx: usize, amount: u64) -> Result<(), PrimitiveError> {
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
    ) -> Result<(), PrimitiveError> {
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

    fn pool_state(&self) -> Result<PoolState, PrimitiveError> {
        let acct = self
            .svm
            .get_account(&self.pool)
            .ok_or_else(|| PrimitiveError::Infra("pool account not found".into()))?;
        let state = LendingPoolState::try_from_slice(&acct.data)
            .map_err(|e| PrimitiveError::Infra(format!("pool decode: {e}")))?;
        Ok(PoolState {
            total_deposits: state.total_deposits,
            total_borrows: state.total_borrows,
            bad_debt: state.bad_debt,
        })
    }

    fn health_factor(&self, agent_idx: usize) -> Result<PositionHealth, PrimitiveError> {
        let key = self
            .positions
            .get(agent_idx)
            .ok_or_else(|| PrimitiveError::Infra(format!("position idx {agent_idx} out of range")))?;
        let acct = self
            .svm
            .get_account(key)
            .ok_or_else(|| PrimitiveError::Infra(format!("position {agent_idx} not found")))?;
        let state = PositionState::try_from_slice(&acct.data)
            .map_err(|e| PrimitiveError::Infra(format!("position decode: {e}")))?;
        Ok(PositionHealth {
            collateral: state.collateral,
            debt: state.debt,
            liquidated: state.liquidated,
        })
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Encode an `f64` as `serde_json::Value::Number`, falling back to
/// `Null` if the value is NaN/Inf (neither can round-trip through
/// `serde_json::Number::from_f64`). Shared by the lending rollup so
/// the determinism gate doesn't see a panic across NaN edge cases.
fn json_f64(value: f64) -> serde_json::Value {
    serde_json::Number::from_f64(value)
        .map(serde_json::Value::Number)
        .unwrap_or(serde_json::Value::Null)
}

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
    // `Harness` is the alias for `LendingPrimitive`; `Primitive` is the
    // base trait that carries the sim-layer concerns (advance_tick,
    // push_oracle_price, execute_action). Tests need both in scope to
    // exercise the full surface.
    use crate::primitive::{Harness, Primitive};

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

    // --- bootstrap tests ---

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

    // --- Harness trait tests ---

    #[test]
    fn harness_agent_count_matches_bootstrap() {
        if skip_if_no_so() { return; }
        let harness = LiteSvmHarness::bootstrap(test_config()).unwrap();
        assert_eq!(harness.agent_count(), 3);
    }

    #[test]
    fn harness_pool_state_returns_seeded_state() {
        if skip_if_no_so() { return; }
        let harness = LiteSvmHarness::bootstrap(test_config()).unwrap();
        let obs = harness.pool_state().unwrap();
        assert_eq!(obs.total_deposits, 150); // 3 agents * 50
        assert_eq!(obs.total_borrows, 0);
        assert_eq!(obs.bad_debt, 0);
    }

    #[test]
    fn harness_health_factor_returns_seeded_state() {
        if skip_if_no_so() { return; }
        let harness = LiteSvmHarness::bootstrap(test_config()).unwrap();
        for idx in 0..3 {
            let obs = harness.health_factor(idx).unwrap();
            assert_eq!(obs.collateral, 50);
            assert_eq!(obs.debt, 0);
            assert!(!obs.liquidated);
        }
    }

    #[test]
    fn harness_health_factor_out_of_range_is_infra() {
        if skip_if_no_so() { return; }
        let harness = LiteSvmHarness::bootstrap(test_config()).unwrap();
        let err = harness.health_factor(999).unwrap_err();
        assert!(matches!(err, PrimitiveError::Infra(_)));
    }

    #[test]
    fn harness_push_oracle_price() {
        if skip_if_no_so() { return; }
        let mut harness = LiteSvmHarness::bootstrap(test_config()).unwrap();
        let update = OracleUpdate { price: 200.0, exponent: 0 };
        harness.push_oracle_price(&update).unwrap();

        let acct = harness.svm.get_account(&harness.oracle).unwrap();
        let oracle = crate::scenario::OracleSnapshot::try_from_slice(&acct.data).unwrap();
        assert_eq!(oracle.price, 200);
    }

    #[test]
    fn harness_deposit_updates_pool_and_position() {
        if skip_if_no_so() { return; }
        let mut harness = LiteSvmHarness::bootstrap(test_config()).unwrap();
        harness.deposit(0, 25).unwrap();

        let pool = harness.pool_state().unwrap();
        assert_eq!(pool.total_deposits, 175); // 150 seeded + 25 new
        let pos = harness.health_factor(0).unwrap();
        assert_eq!(pos.collateral, 75); // 50 seeded + 25 new
    }

    #[test]
    fn harness_withdraw_updates_pool_and_position() {
        if skip_if_no_so() { return; }
        let mut harness = LiteSvmHarness::bootstrap(test_config()).unwrap();
        harness.withdraw(0, 20).unwrap();

        let pool = harness.pool_state().unwrap();
        assert_eq!(pool.total_deposits, 130); // 150 - 20
        let pos = harness.health_factor(0).unwrap();
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

        harness.borrow(0, 10).unwrap();
        let pool = harness.pool_state().unwrap();
        assert_eq!(pool.total_borrows, 10);
        let pos = harness.health_factor(0).unwrap();
        assert_eq!(pos.debt, 10);

        harness.repay(0, 5).unwrap();
        let pool = harness.pool_state().unwrap();
        assert_eq!(pool.total_borrows, 5);
        let pos = harness.health_factor(0).unwrap();
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

        let err = harness.borrow(0, 999_999).unwrap_err();
        assert!(
            matches!(err, PrimitiveError::ProgramRejected(_)),
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

        harness.deposit(0, 500).unwrap();
        harness.borrow(0, 10).unwrap();
        harness.repay(0, 10).unwrap();
        harness.withdraw(0, 500).unwrap();

        let pool = harness.pool_state().unwrap();
        assert_eq!(pool.total_deposits, 0);
        assert_eq!(pool.total_borrows, 0);
        let pos = harness.health_factor(0).unwrap();
        assert_eq!(pos.collateral, 0);
        assert_eq!(pos.debt, 0);
    }

    #[test]
    fn harness_withdraw_with_outstanding_debt_succeeds() {
        if skip_if_no_so() { return; }
        let mut harness = LiteSvmHarness::bootstrap(LiteSvmBootstrapConfig {
            agent_count: 1,
            seed_deposit: 1000,
            starting_price: 100,
            ..Default::default()
        }).unwrap();

        harness.borrow(0, 10).unwrap();
        let pos = harness.health_factor(0).unwrap();
        assert_eq!(pos.debt, 10);

        harness.withdraw(0, 100).unwrap();
        let pos = harness.health_factor(0).unwrap();
        assert_eq!(pos.collateral, 900);
        assert_eq!(pos.debt, 10);
    }

    #[test]
    fn harness_withdraw_with_debt_rejected_when_unhealthy() {
        if skip_if_no_so() { return; }
        let mut harness = LiteSvmHarness::bootstrap(LiteSvmBootstrapConfig {
            agent_count: 1,
            seed_deposit: 100,
            starting_price: 100,
            ..Default::default()
        }).unwrap();

        harness.borrow(0, 500).unwrap();

        let err = harness.withdraw(0, 99).unwrap_err();
        assert!(
            matches!(err, PrimitiveError::ProgramRejected(_)),
            "expected ProgramRejected, got: {err:?}"
        );
    }

    // --- Synthetic chain progression tests ---

    #[test]
    fn advance_tick_progresses_slot_and_blockhash() {
        if skip_if_no_so() { return; }
        let mut harness = LiteSvmHarness::bootstrap(LiteSvmBootstrapConfig {
            agent_count: 1,
            seed_deposit: 100,
            ..Default::default()
        }).unwrap();

        let hash_before = harness.svm.latest_blockhash();
        Primitive::advance_tick(&mut harness);
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

        for tick in 0..5 {
            Primitive::advance_tick(&mut harness);
            let update = OracleUpdate { price: 100.0 + tick as f64, exponent: 0 };
            harness.push_oracle_price(&update).unwrap();
            harness.deposit(0, 10).unwrap();
        }

        let pool = harness.pool_state().unwrap();
        assert_eq!(pool.total_deposits, 150); // 100 seed + 5*10
        assert_eq!(harness.current_slot, 5);
    }

    #[test]
    fn deterministic_bootstrap_produces_same_accounts() {
        if skip_if_no_so() { return; }
        let h1 = LiteSvmHarness::bootstrap(test_config()).unwrap();
        let h2 = LiteSvmHarness::bootstrap(test_config()).unwrap();

        let p1 = h1.pool_state().unwrap();
        let p2 = h2.pool_state().unwrap();
        assert_eq!(p1, p2);

        for i in 0..3 {
            assert_eq!(
                h1.health_factor(i).unwrap(),
                h2.health_factor(i).unwrap()
            );
        }
    }

    /// Same-seed `run_simulation` on the Solend-fork primitive produces
    /// identical event sequences and timeseries — proves determinism on
    /// the real run path, not just isolated tick advances.
    #[test]
    fn same_seed_litesvm_run_is_deterministic() {
        use std::collections::BTreeMap;
        use crate::{
            agent::policy::LENDING_RUNTIME_ACTIONS,
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
                action_rate_multiplier: 1.0,
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
                    weight_boost: None,
                }],
                position_sizing: PositionSizing {
                    strategy: PositionSizingStrategy::Fixed,
                    params: BTreeMap::from([("amount".into(), 50.0)]),
                },
                max_exposure: 0.8,
                persona_args: BTreeMap::new(),
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
                available_actions: LENDING_RUNTIME_ACTIONS.to_vec(),
                starting_balance: 10_000.0,
                starting_price: 100.0,
                simulation_boundaries: vec!["litesvm".into()],
                invariants: Vec::new(),
                scheduled_actions: Vec::new(),
            };
            run_simulation(&mut harness, &mut scenario, params).unwrap()
        }

        let r1 = run_once(42);
        let r2 = run_once(42);

        let event_keys = |events: &[SimEvent]| -> Vec<(u32, String, String)> {
            events.iter().map(|e| (e.tick, e.agent_id.clone(), e.action.clone())).collect()
        };
        assert_eq!(event_keys(&r1.events), event_keys(&r2.events),
            "event sequences diverged across same-seed runs");

        let tvls = |r: &crate::types::SimulationResult| -> Vec<Option<f64>> {
            r.timeseries
                .iter()
                .map(|s| s.get("tvl").and_then(|v| v.as_f64()))
                .collect()
        };
        assert_eq!(tvls(&r1), tvls(&r2),
            "timeseries TVL diverged across same-seed runs");

        let prices = |r: &crate::types::SimulationResult| -> Vec<Option<f64>> {
            r.timeseries
                .iter()
                .map(|s| s.get("oracle_price").and_then(|v| v.as_f64()))
                .collect()
        };
        assert_eq!(prices(&r1), prices(&r2),
            "timeseries oracle_price diverged across same-seed runs");
    }

    // --- LendingPrimitive is the dispatch path ---
    //
    // These tests prove the LendingPrimitive trait is what the tick loop
    // actually calls, not a parallel decorative trait. `harness.deposit(...)`
    // resolves to `LendingPrimitive::deposit` via the super-trait bound
    // `trait Harness: LendingPrimitive`.

    /// Passing the harness through a `&mut dyn LendingPrimitive` and
    /// calling `deposit` must update on-chain state identically to
    /// calling the inherent method. If they diverge, someone split the
    /// impls and the primitive is back to being a parallel trait.
    #[test]
    fn lending_primitive_dyn_dispatch_updates_on_chain_state() {
        if skip_if_no_so() { return; }
        let mut harness = LiteSvmHarness::bootstrap(test_config()).unwrap();
        {
            let dyn_prim: &mut dyn crate::primitive::LendingPrimitive = &mut harness;
            dyn_prim.deposit(0, 25).unwrap();
        }
        let pool = harness.pool_state().unwrap();
        assert_eq!(pool.total_deposits, 175);
        let pos = harness.health_factor(0).unwrap();
        assert_eq!(pos.collateral, 75);
    }

    /// Harness's super-trait bound on LendingPrimitive means the tick
    /// loop can call lending actions through an `H: Harness` generic.
    /// This test drives the harness through a function whose bound is
    /// only `Harness` — if `deposit` weren't coming from
    /// `LendingPrimitive`, this would fail to compile.
    #[test]
    fn tick_loop_path_dispatches_through_lending_primitive() {
        if skip_if_no_so() { return; }
        fn drive<H: Harness>(h: &mut H) -> Result<(), PrimitiveError> {
            // Each of these method calls resolves through the
            // `LendingPrimitive` trait because `Harness: LendingPrimitive`
            // and `Harness` no longer defines these methods itself.
            h.deposit(0, 10)?;
            h.borrow(0, 1)?;
            h.repay(0, 1)?;
            h.withdraw(0, 10)?;
            Ok(())
        }
        let mut harness = LiteSvmHarness::bootstrap(LiteSvmBootstrapConfig {
            agent_count: 1,
            seed_deposit: 100,
            starting_price: 100,
            ..Default::default()
        }).unwrap();
        drive(&mut harness).unwrap();
        let pool = harness.pool_state().unwrap();
        // Net effect: deposit 10, borrow 1, repay 1, withdraw 10 → same as start
        assert_eq!(pool.total_deposits, 100);
        assert_eq!(pool.total_borrows, 0);
    }

    // --- adapter validation is load-bearing at bootstrap ---

    fn sample_lending_adapter() -> crate::adapter::Adapter {
        use crate::adapter::InstructionMapping;
        use std::collections::BTreeMap;
        let mut instructions = BTreeMap::new();
        for name in ["deposit", "borrow", "repay", "withdraw", "liquidate"] {
            instructions.insert(
                name.to_string(),
                InstructionMapping {
                    action: name.to_string(),
                    amount: Some("amount".to_string()),
                    args: BTreeMap::new(),
                },
            );
        }
        let mut state_mapping = BTreeMap::new();
        for (path, obs) in [
            ("pool.total_deposits", "tvl"),
            ("pool.total_borrows", "debt"),
            ("pool.bad_debt", "bad_debt"),
            ("position.collateral", "collateral"),
            ("position.debt", "debt"),
            ("position.liquidated", "liquidated"),
        ] {
            state_mapping.insert(path.to_string(), obs.to_string());
        }
        crate::adapter::Adapter {
            protocol: crate::adapter::Protocol::Lending,
            program_so: None,
            idl_path: None,
            accounts: BTreeMap::new(),
            instructions,
            state_mapping,
            actions: BTreeMap::new(),
            observations: BTreeMap::new(),
            personas: BTreeMap::new(),
            invariants: Vec::new(),
            oracles: Vec::new(),
            scheduled_actions: Vec::new(),
        }
    }

    #[test]
    fn bootstrap_accepts_canonical_adapter() {
        if skip_if_no_so() { return; }
        let mut config = test_config();
        config.adapter = Some(sample_lending_adapter());
        let harness = LiteSvmHarness::bootstrap(config).unwrap();
        // Real post-bootstrap state — proving we actually booted.
        let pool = harness.pool_state().unwrap();
        assert_eq!(pool.total_deposits, 150); // 3 agents × 50 seed
    }

    #[test]
    fn bootstrap_rejects_adapter_with_wrong_action_label() {
        // A schema-valid adapter that wires `deposit` to `borrow`. The
        // TOML loader accepts this (both action names are canonical
        // lending actions), but the Solend-fork primitive rejects it
        // because the concrete wiring is wrong.
        let mut adapter = sample_lending_adapter();
        adapter
            .instructions
            .get_mut("deposit")
            .unwrap()
            .action = "borrow".to_string();

        let mut config = test_config();
        config.adapter = Some(adapter);
        let err = match LiteSvmHarness::bootstrap(config) {
            Ok(_) => panic!("expected adapter validation to fail"),
            Err(e) => format!("{e:#}"),
        };
        assert!(
            err.contains("[instructions].deposit.action"),
            "error should name the failing key: {err}"
        );
        assert!(err.contains("borrow"), "error should include actual value: {err}");
    }

    #[test]
    fn bootstrap_rejects_adapter_missing_state_mapping_entry() {
        let mut adapter = sample_lending_adapter();
        adapter.state_mapping.remove("pool.total_deposits");

        let mut config = test_config();
        config.adapter = Some(adapter);
        let err = match LiteSvmHarness::bootstrap(config) {
            Ok(_) => panic!("expected adapter validation to fail"),
            Err(e) => format!("{e:#}"),
        };
        assert!(
            err.contains("pool.total_deposits"),
            "error should name the missing key: {err}"
        );
    }

    #[test]
    fn bootstrap_rejects_adapter_with_swapped_observation_names() {
        // A schema-valid adapter that maps `pool.total_deposits` to
        // `debt` instead of `tvl`. Schema-wise both are in
        // LENDING_OBSERVATIONS, but the Solend-fork primitive requires
        // the canonical binding.
        let mut adapter = sample_lending_adapter();
        adapter
            .state_mapping
            .insert("pool.total_deposits".to_string(), "debt".to_string());

        let mut config = test_config();
        config.adapter = Some(adapter);
        let err = match LiteSvmHarness::bootstrap(config) {
            Ok(_) => panic!("expected adapter validation to fail"),
            Err(e) => format!("{e:#}"),
        };
        assert!(err.contains("pool.total_deposits"), "got: {err}");
        assert!(err.contains("tvl"), "got: {err}");
    }
}
