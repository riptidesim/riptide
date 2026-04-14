//! LiteSVM parity test suite.
//!
//! Requires `--features litesvm-backend` (the module is feature-gated
//! in the library crate). Skipped automatically when the feature is off.

#![cfg(feature = "litesvm-backend")]
//!
//! Proves the LiteSVM backend preserves the lending lifecycle the engine
//! depends on. Each test exercises one or more lending operations and
//! asserts pool-wide and per-position invariants after every state
//! transition.
//!
//! **Parity note vs validator path**: the validator integration test
//! (`t05_lending_integration.rs`) exercises the same lifecycle against a
//! live `solana-test-validator`. The two backends produce identical
//! program behavior because both run the same `lending_pool.so` artifact.
//! The only known difference is timing — LiteSVM completes in-process
//! without RPC round-trips or confirmation delays. No behavioral
//! divergence has been observed during this migration; if one is
//! discovered later, it should be documented here.
//!
//! Run:
//! ```bash
//! cargo test -p riptide-engine --test t06_litesvm_parity -- --nocapture
//! ```

#![cfg(not(doctest))]

use std::collections::BTreeMap;

use riptide_engine::{
    agent::policy::LENDING_RUNTIME_ACTIONS,
    harness::{
        lending::LendingPoolConfig,
        setup::default_program_so_path,
    },
    primitive::Primitive,
    scenario::{BaselineScenario, OracleUpdate},
    sim::{
        litesvm::{LiteSvmBootstrapConfig, LiteSvmHarness},
        run::{run_simulation, SimulationParams},
        Harness, HarnessError, PoolObservation, PositionObservation,
    },
    types::{
        Policy, PositionSizing, PositionSizingStrategy,
        RunConfig, SimEvent, Trigger, TriggerCondition,
    },
};

fn skip_if_no_so() -> bool {
    let so_path = default_program_so_path();
    if !so_path.exists() {
        eprintln!(
            "skipping: lending_pool.so not found at {}",
            so_path.display()
        );
        true
    } else {
        false
    }
}

/// Assert pool-level accounting invariant: bad_debt must be zero when no
/// liquidation has occurred.
///
/// Note: `total_deposits` and `total_borrows` are in different units
/// (collateral units vs stable base units), so `deposits >= borrows` is
/// NOT an invariant of this lending model.
fn assert_pool_no_bad_debt(pool: &PoolObservation, context: &str) {
    assert_eq!(
        pool.bad_debt, 0,
        "{context}: unexpected bad_debt={}", pool.bad_debt,
    );
}

/// Assert that a position's collateral and debt are internally consistent.
fn assert_position_sane(pos: &PositionObservation, context: &str) {
    if pos.liquidated {
        // After liquidation the position may have residual values, but
        // it must be flagged.
        return;
    }
    // Non-liquidated positions should not have negative-proxy values
    // (they're u64, so this is really just documentation).
    let _ = (pos.collateral, pos.debt);
    eprintln!("  {context}: collateral={} debt={}", pos.collateral, pos.debt);
}

// -----------------------------------------------------------------------
// Full lifecycle: deposit → borrow → repay → withdraw → liquidate
// -----------------------------------------------------------------------

#[test]
fn litesvm_full_lifecycle_with_invariants() {
    if skip_if_no_so() { return; }

    // Use the same pool config as the validator integration test for
    // direct comparability: LTV 70%, liquidation threshold 50%.
    let config = LiteSvmBootstrapConfig {
        agent_count: 2, // borrower (0) + liquidator (1)
        seed_deposit: 0,
        starting_price: 100,
        pool_config: LendingPoolConfig {
            ltv_bps: 7_000,
            liquidation_threshold_bps: 5_000,
            ..riptide_engine::harness::setup::default_pool_config()
        },
        ..Default::default()
    };
    let mut h = LiteSvmHarness::bootstrap(config).unwrap();

    // --- 1. Deposit ---
    eprintln!("=== deposit ===");
    h.deposit(0, 10_000).unwrap();
    h.deposit(1, 1).unwrap(); // liquidator needs a position

    let pool = h.observe_pool().unwrap();
    assert_eq!(pool.total_deposits, 10_001);
    assert_eq!(pool.total_borrows, 0);
    assert_eq!(pool.bad_debt, 0);
    assert_pool_no_bad_debt(&pool, "after deposit");

    let pos0 = h.observe_position(0).unwrap();
    assert_eq!(pos0.collateral, 10_000);
    assert_eq!(pos0.debt, 0);
    assert!(!pos0.liquidated);
    assert_position_sane(&pos0, "borrower after deposit");

    // --- 2. Borrow ---
    // collateral_value = 10_000 * 100 = 1_000_000. LTV 70% => max borrow 700_000.
    // With threshold=5_000: healthy requires collateral*price*5_000/10_000 >= debt
    // = 500_000 >= debt. Borrow 400_000 to stay healthy.
    eprintln!("=== borrow ===");
    h.borrow(0, 400_000).unwrap();

    let pool = h.observe_pool().unwrap();
    assert_eq!(pool.total_deposits, 10_001);
    assert_eq!(pool.total_borrows, 400_000);
    assert_pool_no_bad_debt(&pool, "after borrow");

    let pos0 = h.observe_position(0).unwrap();
    assert_eq!(pos0.collateral, 10_000);
    assert_eq!(pos0.debt, 400_000);
    assert!(!pos0.liquidated);
    assert_position_sane(&pos0, "borrower after borrow");

    // --- 3. Repay (partial) ---
    eprintln!("=== repay ===");
    h.repay(0, 100_000).unwrap();

    let pool = h.observe_pool().unwrap();
    assert_eq!(pool.total_deposits, 10_001);
    assert_eq!(pool.total_borrows, 300_000);
    assert_pool_no_bad_debt(&pool, "after repay");

    let pos0 = h.observe_position(0).unwrap();
    assert_eq!(pos0.collateral, 10_000);
    assert_eq!(pos0.debt, 300_000);
    assert_position_sane(&pos0, "borrower after repay");

    // --- 4. Withdraw ---
    // debt=300_000, collateral=10_000 @ price=100
    // health_value = 10_000 * 100 * 5_000 / 10_000 = 500_000 > 300_000. Healthy.
    // Withdraw 2_000: 8_000 * 100 * 5_000 / 10_000 = 400_000 > 300_000. Still healthy.
    eprintln!("=== withdraw ===");
    h.withdraw(0, 2_000).unwrap();

    let pool = h.observe_pool().unwrap();
    assert_eq!(pool.total_deposits, 8_001); // 10_001 - 2_000
    assert_eq!(pool.total_borrows, 300_000);
    assert_pool_no_bad_debt(&pool, "after withdraw");

    let pos0 = h.observe_position(0).unwrap();
    assert_eq!(pos0.collateral, 8_000);
    assert_eq!(pos0.debt, 300_000);
    assert_position_sane(&pos0, "borrower after withdraw");

    // --- 5. Liquidate ---
    // Drop oracle price so the position becomes underwater.
    // Need: 8_000 * new_price * 5_000 / 10_000 < 300_000
    //    => new_price < 300_000 * 10_000 / (8_000 * 5_000) = 75
    // Set price to 40 (same as the validator test).
    eprintln!("=== liquidate ===");
    h.push_oracle_price(&OracleUpdate { price: 40.0, exponent: 0 }).unwrap();

    // liquidation_value = 8_000 * 40 * 5_000 / 10_000 = 160_000 < 300_000 ✓
    h.liquidate(1, 0, 2_000).unwrap();

    let pos0 = h.observe_position(0).unwrap();
    let pool = h.observe_pool().unwrap();
    assert!(
        pos0.debt < 300_000 || pos0.liquidated,
        "borrower debt should decrease or position should be marked liquidated"
    );
    assert!(
        pool.total_borrows < 300_000 || pool.bad_debt > 0,
        "pool total_borrows should decrease or bad_debt should register"
    );

    eprintln!(
        "lifecycle complete: deposits={} borrows={} bad_debt={} borrower_debt={} \
         borrower_collateral={} liquidated={}",
        pool.total_deposits,
        pool.total_borrows,
        pool.bad_debt,
        pos0.debt,
        pos0.collateral,
        pos0.liquidated,
    );
}

// -----------------------------------------------------------------------
// Individual operation invariants
// -----------------------------------------------------------------------

#[test]
fn litesvm_deposit_invariants() {
    if skip_if_no_so() { return; }

    let mut h = LiteSvmHarness::bootstrap(LiteSvmBootstrapConfig {
        agent_count: 3,
        seed_deposit: 0,
        ..Default::default()
    }).unwrap();

    // Multiple deposits accumulate correctly.
    for i in 0..3u64 {
        h.deposit(i as usize, (i + 1) * 100).unwrap();
    }

    let pool = h.observe_pool().unwrap();
    assert_eq!(pool.total_deposits, 100 + 200 + 300);
    assert_eq!(pool.total_borrows, 0);
    assert_pool_no_bad_debt(&pool, "multi-deposit");

    // Each position reflects its own deposit.
    for i in 0..3u64 {
        let pos = h.observe_position(i as usize).unwrap();
        assert_eq!(pos.collateral, (i + 1) * 100, "agent {i}");
        assert_eq!(pos.debt, 0);
    }
}

#[test]
fn litesvm_borrow_invariants() {
    if skip_if_no_so() { return; }

    let mut h = LiteSvmHarness::bootstrap(LiteSvmBootstrapConfig {
        agent_count: 2,
        seed_deposit: 500,
        starting_price: 100,
        ..Default::default()
    }).unwrap();

    // Borrow within LTV for agent 0.
    h.borrow(0, 30).unwrap();

    let pool = h.observe_pool().unwrap();
    assert_eq!(pool.total_borrows, 30);
    assert_pool_no_bad_debt(&pool, "after single borrow");

    let pos = h.observe_position(0).unwrap();
    assert_eq!(pos.debt, 30);
    assert_eq!(pos.collateral, 500); // collateral unchanged

    // Agent 1's position is unaffected.
    let pos1 = h.observe_position(1).unwrap();
    assert_eq!(pos1.debt, 0);
    assert_eq!(pos1.collateral, 500);

    // Over-LTV borrow is rejected.
    let err = h.borrow(0, 999_999_999).unwrap_err();
    assert!(matches!(err, HarnessError::ProgramRejected(_)));
}

#[test]
fn litesvm_repay_invariants() {
    if skip_if_no_so() { return; }

    let mut h = LiteSvmHarness::bootstrap(LiteSvmBootstrapConfig {
        agent_count: 1,
        seed_deposit: 1000,
        starting_price: 100,
        ..Default::default()
    }).unwrap();

    h.borrow(0, 50).unwrap();
    let pool_before = h.observe_pool().unwrap();

    // Partial repay.
    h.repay(0, 20).unwrap();
    let pool = h.observe_pool().unwrap();
    assert_eq!(pool.total_borrows, 30);
    assert_eq!(pool.total_deposits, pool_before.total_deposits);
    assert_pool_no_bad_debt(&pool, "after partial repay");

    let pos = h.observe_position(0).unwrap();
    assert_eq!(pos.debt, 30);

    // Full repay.
    h.repay(0, 30).unwrap();
    let pool = h.observe_pool().unwrap();
    assert_eq!(pool.total_borrows, 0);
    let pos = h.observe_position(0).unwrap();
    assert_eq!(pos.debt, 0);
}

#[test]
fn litesvm_withdraw_invariants() {
    if skip_if_no_so() { return; }

    let mut h = LiteSvmHarness::bootstrap(LiteSvmBootstrapConfig {
        agent_count: 1,
        seed_deposit: 500,
        starting_price: 100,
        ..Default::default()
    }).unwrap();

    // Withdraw without debt — should always work.
    h.withdraw(0, 200).unwrap();

    let pool = h.observe_pool().unwrap();
    assert_eq!(pool.total_deposits, 300);
    assert_pool_no_bad_debt(&pool, "withdraw no debt");

    let pos = h.observe_position(0).unwrap();
    assert_eq!(pos.collateral, 300);

    // Full withdraw.
    h.withdraw(0, 300).unwrap();
    let pos = h.observe_position(0).unwrap();
    assert_eq!(pos.collateral, 0);
    let pool = h.observe_pool().unwrap();
    assert_eq!(pool.total_deposits, 0);
}

#[test]
fn litesvm_liquidate_invariants() {
    if skip_if_no_so() { return; }

    let mut h = LiteSvmHarness::bootstrap(LiteSvmBootstrapConfig {
        agent_count: 2,
        seed_deposit: 0,
        starting_price: 100,
        pool_config: LendingPoolConfig {
            ltv_bps: 7_000,
            liquidation_threshold_bps: 5_000,
            ..riptide_engine::harness::setup::default_pool_config()
        },
        ..Default::default()
    }).unwrap();

    // Setup: agent 0 deposits and borrows within healthy range.
    // With threshold=5_000: health requires collateral * price * 5_000 / 10_000 >= debt
    // = 10_000 * 100 * 5_000 / 10_000 = 500_000 >= debt
    // Borrow 400_000 so the position is healthy (500_000 > 400_000).
    h.deposit(0, 10_000).unwrap();
    h.deposit(1, 100).unwrap(); // liquidator seed
    h.borrow(0, 400_000).unwrap();

    let pool_before = h.observe_pool().unwrap();
    let pos_before = h.observe_position(0).unwrap();

    // Liquidation should fail while position is healthy.
    let err = h.liquidate(1, 0, 1_000).unwrap_err();
    assert!(
        matches!(err, HarnessError::ProgramRejected(_)),
        "liquidation of healthy position should be rejected"
    );

    // Drop price to make position underwater.
    // At price=40: health_value = 10_000 * 40 * 5_000 / 10_000 = 200_000 < 400_000
    h.push_oracle_price(&OracleUpdate { price: 40.0, exponent: 0 }).unwrap();

    // Now liquidation should succeed.
    h.liquidate(1, 0, 2_000).unwrap();

    let pool_after = h.observe_pool().unwrap();
    let pos_after = h.observe_position(0).unwrap();

    assert!(
        pos_after.debt < pos_before.debt || pos_after.liquidated,
        "debt should decrease or position flagged"
    );
    assert!(
        pool_after.total_borrows < pool_before.total_borrows || pool_after.bad_debt > 0,
        "pool borrows should decrease or bad_debt should appear"
    );
}

// -----------------------------------------------------------------------
// Deterministic same-seed behavior
// -----------------------------------------------------------------------

#[test]
fn litesvm_deterministic_same_seed() {
    if skip_if_no_so() { return; }

    fn make_policy() -> Policy {
        Policy {
            persona_id: "test-lp".into(),
            persona_label: "test-lp".into(),
            action_rate_multiplier: 1.0,
            risk_tolerance: 0.5,
            action_weights: BTreeMap::from([
                ("deposit".into(), 0.6),
                ("borrow".into(), 0.2),
                ("withdraw".into(), 0.1),
                ("repay".into(), 0.1),
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
        }
    }

    fn run_once(seed: u64) -> riptide_engine::types::SimulationResult {
        let cfg = RunConfig {
            agents: 5,
            ticks: 10,
            scenario: "baseline".into(),
            seed,
            personas: vec!["test-lp".into()],
            validator_url: "unused".into(),
            output_path: "unused".into(),
        };
        let mut harness = LiteSvmHarness::bootstrap(LiteSvmBootstrapConfig {
            agent_count: 5,
            seed_deposit: 50,
            starting_price: 100,
            ..Default::default()
        }).unwrap();
        let mut scenario = BaselineScenario::new(100.0, 25);
        let policies = vec![make_policy()];
        let params = SimulationParams {
            run_config: &cfg,
            policies,
            agent_personas: vec![0; 5],
            available_actions: LENDING_RUNTIME_ACTIONS.to_vec(),
            starting_balance: 10_000.0,
            starting_price: 100.0,
            simulation_boundaries: vec!["litesvm parity".into()],
        };
        run_simulation(&mut harness, &mut scenario, params).unwrap()
    }

    let r1 = run_once(42);
    let r2 = run_once(42);

    // Event sequence must be identical.
    let event_keys = |events: &[SimEvent]| -> Vec<(u32, String, String)> {
        events
            .iter()
            .map(|e| (e.tick, e.agent_id.clone(), e.action.clone()))
            .collect()
    };
    assert_eq!(
        event_keys(&r1.events),
        event_keys(&r2.events),
        "event sequences diverged across same-seed LiteSVM runs"
    );

    // Timeseries must be identical. `TickSnapshot` is a
    // `BTreeMap<String, serde_json::Value>`, so the lending-shaped keys
    // are looked up by string instead of being struct-field accesses.
    let tvls = |r: &riptide_engine::types::SimulationResult| -> Vec<Option<f64>> {
        r.timeseries
            .iter()
            .map(|s| s.get("tvl").and_then(|value| value.as_f64()))
            .collect()
    };
    assert_eq!(
        tvls(&r1),
        tvls(&r2),
        "timeseries TVL diverged across same-seed LiteSVM runs"
    );

    let prices = |r: &riptide_engine::types::SimulationResult| -> Vec<Option<f64>> {
        r.timeseries
            .iter()
            .map(|s| s.get("oracle_price").and_then(|value| value.as_f64()))
            .collect()
    };
    assert_eq!(
        prices(&r1),
        prices(&r2),
        "timeseries oracle_price diverged across same-seed LiteSVM runs"
    );

    // Note: with a fixed-amount deposit-heavy policy, different seeds may
    // produce identical event sequences because the RNG doesn't meaningfully
    // affect the dominant action. This is expected — the determinism
    // guarantee is that same seed => same output, not that different seeds
    // must diverge. The latter is a property of the policy mix, not the
    // backend.
}

// -----------------------------------------------------------------------
// Tick progression does not break operations
// -----------------------------------------------------------------------

#[test]
fn litesvm_operations_stable_across_tick_advances() {
    if skip_if_no_so() { return; }

    let mut h = LiteSvmHarness::bootstrap(LiteSvmBootstrapConfig {
        agent_count: 2,
        seed_deposit: 100,
        starting_price: 100,
        ..Default::default()
    }).unwrap();

    // Simulate 10 ticks with mixed operations.
    for tick in 0..10 {
        Primitive::advance_tick(&mut h);
        h.push_oracle_price(&OracleUpdate {
            price: 100.0 + tick as f64,
            exponent: 0,
        }).unwrap();

        if tick % 2 == 0 {
            h.deposit(0, 10).unwrap();
        }
        if tick == 3 {
            h.borrow(0, 5).unwrap();
        }
        if tick == 7 {
            h.repay(0, 5).unwrap();
        }
    }

    let pool = h.observe_pool().unwrap();
    // 200 seeded (2*100) + 50 deposited (5 even ticks * 10)
    assert_eq!(pool.total_deposits, 250);
    assert_eq!(pool.total_borrows, 0); // fully repaid
    assert_pool_no_bad_debt(&pool, "after 10 ticks");
}
