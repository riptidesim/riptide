//! Dedicated end-to-end determinism gate.
//!
//! `litesvm_parity::litesvm_deterministic_same_seed` remains in place as
//! the lending-path regression test. This file adds byte-stable output
//! assertions for both the shipped lending fixture shape and the
//! generic/resource-grinder fixture.

#![cfg(feature = "litesvm-backend")]
#![cfg(not(doctest))]

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use riptide_engine::{
    adapter::{load_adapter, parse_adapter_str},
    agent::policy::LENDING_RUNTIME_ACTIONS,
    harness::setup::default_program_so_path,
    primitive::{
        build_generic_policies, generic_runtime_actions, GenericBootstrapConfig, GenericHarness,
    },
    scenario::BaselineScenario,
    sim::{
        build_agent_personas,
        litesvm::{LiteSvmBootstrapConfig, LiteSvmHarness},
        run::{run_generic_simulation, run_simulation, SimulationParams},
    },
    types::{
        Policy, PositionSizing, PositionSizingStrategy, RunConfig, SimOutcome, SimulationResult,
        Trigger, TriggerCondition,
    },
};

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn monorepo_root() -> PathBuf {
    manifest_dir().parent().unwrap().to_path_buf()
}

fn canonical_bytes(result: &SimulationResult) -> Vec<u8> {
    serde_json::to_vec(result).expect("serialize simulation result")
}

fn skip_if_missing(path: &Path, label: &str) -> bool {
    if !path.exists() {
        eprintln!("skipping: {label} missing at {}", path.display());
        true
    } else {
        false
    }
}

fn lending_policy() -> Policy {
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
        persona_args: BTreeMap::new(),
    }
}

fn run_lending_fixture(seed: u64) -> SimulationResult {
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
    })
    .unwrap();
    let mut scenario = BaselineScenario::new(100.0, 25);
    let params = SimulationParams {
        run_config: &cfg,
        policies: vec![lending_policy()],
        agent_personas: vec![0; 5],
        available_actions: LENDING_RUNTIME_ACTIONS.to_vec(),
        starting_balance: 10_000.0,
        starting_price: 100.0,
        simulation_boundaries: vec!["t15 lending".into()],
        invariants: Vec::new(),
        scheduled_actions: Vec::new(),
        semantics: None,
        errors: Vec::new(),
    };
    run_simulation(&mut harness, &mut scenario, params).unwrap()
}

fn semantic_lending_toml() -> &'static str {
    r#"
protocol = "lending"

[instructions]
deposit   = { action = "deposit",   amount = "amount" }
borrow    = { action = "borrow",    amount = "amount" }
repay     = { action = "repay",     amount = "amount" }
withdraw  = { action = "withdraw",  amount = "amount" }
liquidate = { action = "liquidate", amount = "repay_amount" }

[state_mapping]
"pool.total_deposits" = "tvl"
"pool.total_borrows"  = "debt"
"pool.bad_debt"       = "bad_debt"
"position.collateral" = "collateral"
"position.debt"       = "debt"
"position.liquidated" = "liquidated"

[semantics]
class = "lending.v1"

[semantics.roles.position]
source = "account.position"
fields.collateral_amount = "u128"
fields.debt_amount = "u128"

[semantics.roles.reserve]
source = "account.reserve"
fields.max_ltv_bps = "u64"
fields.collateral_price = "u128"

[semantics.roles.oracle]
source = "account.oracle"
fields.price = "u128"

[semantics.roles.liquidation_config]
source = "account.reserve"
fields.liquidation_threshold_bps = "u64"

[semantics.derived]
collateral_value = "position.collateral_amount * oracle.price"
debt_value = "position.debt_amount"
max_borrow_value = "collateral_value * reserve.max_ltv_bps / 10000"
health_factor = "collateral_value / max(debt_value, 1)"

[[semantics.invariants]]
name = "ltv_below_max"
expr = "debt_value <= max_borrow_value"
severity = "warn"
"#
}

fn run_semantic_lending_fixture(seed: u64) -> SimulationResult {
    let adapter = parse_adapter_str(semantic_lending_toml(), "semantic-lending.toml")
        .expect("parse semantic lending adapter");
    let cfg = RunConfig {
        agents: 1,
        ticks: 10,
        scenario: "baseline".into(),
        seed,
        personas: vec!["test-lp".into()],
        validator_url: "unused".into(),
        output_path: "unused".into(),
    };
    let mut harness = LiteSvmHarness::bootstrap(LiteSvmBootstrapConfig {
        agent_count: 1,
        seed_deposit: 50,
        starting_price: 100,
        ..Default::default()
    })
    .unwrap();
    let mut scenario = BaselineScenario::new(100.0, 25);
    let params = SimulationParams {
        run_config: &cfg,
        policies: vec![lending_policy()],
        agent_personas: vec![0],
        available_actions: LENDING_RUNTIME_ACTIONS.to_vec(),
        starting_balance: 10_000.0,
        starting_price: 100.0,
        simulation_boundaries: vec!["t15 semantic lending".into()],
        invariants: Vec::new(),
        scheduled_actions: Vec::new(),
        semantics: adapter.semantics.clone(),
        errors: Vec::new(),
    };
    run_simulation(&mut harness, &mut scenario, params).unwrap()
}

fn run_generic_fixture(seed: u64) -> SimulationResult {
    let repo = monorepo_root();
    let adapter_path = repo.join("fixtures/adapters/resource-grinder.toml");
    let run_config_path = repo.join("fixtures/generic-demo.run.json");
    let adapter = load_adapter(&adapter_path).expect("load generic adapter");
    let mut run_config: RunConfig = serde_json::from_str(
        &fs::read_to_string(&run_config_path).expect("read generic demo run config"),
    )
    .expect("parse generic demo run config");
    run_config.seed = seed;

    let policies = build_generic_policies(&adapter, |_| {}).expect("build generic policies");
    let agent_personas =
        build_agent_personas(&run_config.personas, &policies, run_config.agents as usize)
            .expect("resolve generic personas");

    let mut harness = GenericHarness::bootstrap(GenericBootstrapConfig {
        program_so: PathBuf::from(adapter.program_so.as_deref().unwrap()),
        idl_path: PathBuf::from(adapter.idl_path.as_deref().unwrap()),
        agent_count: run_config.agents as usize,
        adapter: adapter.clone(),
    })
    .unwrap();
    let mut scenario = BaselineScenario::new(100.0, 25);
    let params = SimulationParams {
        run_config: &run_config,
        policies,
        agent_personas,
        available_actions: generic_runtime_actions(&adapter),
        starting_balance: 20_000.0,
        starting_price: 100.0,
        simulation_boundaries: vec!["t15 generic".into()],
        invariants: Vec::new(),
        scheduled_actions: Vec::new(),
        semantics: None,
        errors: Vec::new(),
    };
    run_generic_simulation(&mut harness, &mut scenario, params).unwrap()
}

/// Keys the lending rollup emits. `t15` uses this set twice: to assert
/// the lending fixture still populates them, and to assert the generic
/// fixture does NOT (i.e. the generic rollup is not secretly pulling
/// lending-shaped defaults).
const LENDING_SUMMARY_KEYS: &[&str] = &[
    "final_tvl",
    "final_utilization",
    "total_liquidations",
    "total_bad_debt",
    "largest_single_tick_drawdown",
];

const LENDING_TICK_KEYS: &[&str] = &[
    "tvl",
    "utilization",
    "oracle_price",
    "cumulative_liquidations",
    "cumulative_bad_debt",
];

#[test]
fn lending_fixture_is_byte_stable_same_seed() {
    let program_so = default_program_so_path();
    if skip_if_missing(&program_so, "lending_pool.so") {
        return;
    }

    let first = run_lending_fixture(42);
    let second = run_lending_fixture(42);
    assert_eq!(
        canonical_bytes(&first),
        canonical_bytes(&second),
        "lending fixture output diverged across same-seed runs"
    );

    // Contract: the lending path still populates every historical
    // summary + timeseries key.
    for key in LENDING_SUMMARY_KEYS {
        assert!(
            first.summary.contains_key(*key),
            "lending summary missing historical key `{key}`: {:?}",
            first.summary
        );
    }
    for entry in &first.timeseries {
        for key in LENDING_TICK_KEYS {
            assert!(
                entry.contains_key(*key),
                "lending timeseries entry missing historical key `{key}` at tick {:?}",
                entry.get("tick")
            );
        }
    }
}

#[test]
fn semantic_lending_fixture_is_byte_stable_same_seed() {
    let program_so = default_program_so_path();
    if skip_if_missing(&program_so, "lending_pool.so") {
        return;
    }

    let first = run_semantic_lending_fixture(42);
    let second = run_semantic_lending_fixture(42);
    assert_eq!(
        canonical_bytes(&first),
        canonical_bytes(&second),
        "semantic lending fixture output diverged across same-seed runs"
    );

    for entry in &first.timeseries {
        let derived = entry
            .get("derived_observations")
            .and_then(|value| value.as_object())
            .expect("semantic lending ticks must include derived_observations");
        assert!(
            derived.contains_key("collateral_value"),
            "derived observations missing collateral_value: {derived:?}"
        );
        assert!(
            derived.contains_key("max_borrow_value"),
            "derived observations missing max_borrow_value: {derived:?}"
        );
    }
    let expression_rows = first
        .summary
        .get("expression_invariants")
        .and_then(|value| value.as_array())
        .expect("semantic lending summary must include expression_invariants");
    assert_eq!(expression_rows.len(), 1);
    assert_eq!(expression_rows[0]["name"], "ltv_below_max");
}

#[test]
fn generic_fixture_is_byte_stable_same_seed() {
    let repo = monorepo_root();
    let program_so = repo.join("programs/resource_grinder/target/deploy/resource_grinder.so");
    if skip_if_missing(&program_so, "resource_grinder.so") {
        return;
    }

    let first = run_generic_fixture(42);
    let second = run_generic_fixture(42);
    assert_eq!(
        canonical_bytes(&first),
        canonical_bytes(&second),
        "generic fixture output diverged across same-seed runs"
    );
    assert!(
        first
            .events
            .iter()
            .any(|event| event.outcome == SimOutcome::Success),
        "generic fixture should produce at least one successful event"
    );
    assert!(
        first
            .events
            .iter()
            .any(|event| event.triggered_by.is_some()),
        "generic fixture should surface at least one persona trigger in the event log"
    );

    // Contract: the generic rollup is driven by the adapter's
    // `[observations]` block. The summary must contain at least one
    // adapter-derived key and must not carry any lending-shaped keys.
    assert!(
        !first.summary.is_empty(),
        "generic summary must be non-empty: {:?}",
        first.summary
    );
    for key in LENDING_SUMMARY_KEYS {
        assert!(
            !first.summary.contains_key(*key),
            "generic summary must not carry lending-shaped key `{key}`: {:?}",
            first.summary
        );
    }
    // Every timeseries entry must be non-trivial (primitive-specific
    // metrics are present alongside the engine-side counters) and
    // must not contain the lending-specific `tvl`/`utilization`/
    // `oracle_price` / `cumulative_*` columns.
    for entry in &first.timeseries {
        for key in LENDING_TICK_KEYS {
            assert!(
                !entry.contains_key(*key),
                "generic timeseries entry must not carry lending-shaped key `{key}`: {entry:?}"
            );
        }
    }
    // At least one adapter-declared observation key must appear in the
    // summary (e.g. `player.gold_avg`). Look for any key containing a
    // dot, since the resource-grinder adapter declares dotted paths.
    assert!(
        first.summary.keys().any(|key| key.contains('.')),
        "generic summary must contain at least one adapter-declared observation key: {:?}",
        first.summary
    );
    // Same rule for timeseries entries past tick 0 — we expect at
    // least one dotted adapter key present per tick.
    let mid = &first.timeseries[first.timeseries.len() / 2];
    assert!(
        mid.keys().any(|key| key.contains('.')),
        "generic timeseries mid-entry must contain an adapter observation: {mid:?}"
    );
}
