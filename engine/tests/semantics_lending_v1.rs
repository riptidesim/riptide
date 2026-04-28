use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use riptide_engine::{
    adapter::{load_adapter, parse_adapter_str, Adapter},
    agent::{policy::LENDING_RUNTIME_ACTIONS, state::Agent},
    primitive::SemanticOracleObservation,
    replay::{load_replay_bundle, run_lending_replay},
    scenario::{BaselineScenario, PriceShockScenario},
    semantics::{
        derived::evaluate_derived_observations,
        invariants::evaluate_expression_invariants,
        roles::{bind_lending_v1_roles, RoleBindingContext},
        Value as SemanticValue,
    },
    sim::{run_simulation, MockHarness, SimulationParams},
    types::{
        Policy, PositionSizing, PositionSizingStrategy, RunConfig, SimOutcome, TickSnapshot,
        Trigger, TriggerCondition,
    },
};

const LENDING_SEMANTIC_ORACLE_PUBKEY: &str = "29By8wxvCwsogbbTvFDRWKMpydxYe94RhUSPY17y5MEn";
const LENDING_PROGRAM_PUBKEY: &str = "CwvZXfji8FDrzbKnBozHWJ4PkKULYwDvn7UrYCiBDXvu";

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
fields.confidence = "u64"

[semantics.roles.liquidation_config]
source = "account.reserve"
fields.liquidation_threshold_bps = "u64"

[semantics.derived]
collateral_value = "position.collateral_amount * oracle.price"
debt_value = "position.debt_amount"
max_borrow_value = "collateral_value * reserve.max_ltv_bps / 10000"
health_factor = "collateral_value / max(debt_value, 1)"

[[semantics.invariants]]
name = "bad_debt_bound"
expr = "debt_value <= collateral_value"
severity = "warn"

[[semantics.invariants]]
name = "ltv_below_max"
expr = "debt_value <= max_borrow_value"
severity = "warn"
"#
}

fn semantic_lending_replay_toml() -> &'static str {
    r#"
protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }
borrow = { action = "borrow", amount = "amount" }
liquidate = { action = "liquidate", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"
"pool.total_borrows" = "debt"
"pool.bad_debt" = "bad_debt"

[semantics]
class = "lending.v1"

[semantics.roles.position]
source = "instruction.borrow"
fields.collateral_amount = "u128"
fields.debt_amount = "u128"

[semantics.roles.reserve]
source = "account.reserve"
fields.max_ltv_bps = "u64"
fields.collateral_price = "u128"

[semantics.roles.oracle]
source = "account.oracle"
fields.price = "u128"
fields.confidence = "u64"

[semantics.roles.liquidation_config]
source = "account.reserve"
fields.liquidation_threshold_bps = "u64"

[semantics.derived]
collateral_value = "position.collateral_amount * oracle.price"
debt_value = "position.debt_amount"
max_borrow_value = "collateral_value * reserve.max_ltv_bps / 10000"

[[semantics.invariants]]
name = "replay_debt_bound"
expr = "debt_value <= 1"
severity = "error"
"#
}

fn make_temp_replay_dir(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("riptide-{label}-{nonce}"));
    fs::create_dir_all(&dir).expect("create temp replay dir");
    dir
}

fn monorepo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("engine crate has a parent directory")
        .to_path_buf()
}

fn shipping_usdc_oracle_observation() -> SemanticOracleObservation {
    SemanticOracleObservation {
        price: 100,
        confidence: 0,
        staleness: 0,
        exponent: 0,
    }
}

fn policy() -> Policy {
    Policy {
        persona_id: "semantic-lp".into(),
        persona_label: "semantic-lp".into(),
        action_rate_multiplier: 1.0,
        risk_tolerance: 0.5,
        action_weights: BTreeMap::from([
            ("deposit".into(), 0.0),
            ("borrow".into(), 0.0),
            ("withdraw".into(), 0.0),
            ("repay".into(), 0.0),
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
            params: BTreeMap::from([("amount".into(), 0.0)]),
        },
        max_exposure: 0.0,
        persona_args: BTreeMap::new(),
    }
}

fn run_single_agent_semantic_lending(adapter: &Adapter) -> riptide_engine::types::SimulationResult {
    let cfg = RunConfig {
        agents: 1,
        ticks: 0,
        scenario: "baseline".into(),
        seed: 19,
        personas: vec!["semantic-lp".into()],
        validator_url: "unused".into(),
        output_path: "unused".into(),
    };
    let mut harness = MockHarness::new(1, 100.0).with_risk_params(7_000, 8_000);
    harness.seed_position(0, 10, 800);
    let mut scenario = BaselineScenario::new(100.0, 0);
    let params = SimulationParams {
        run_config: &cfg,
        policies: vec![policy()],
        agent_personas: vec![0],
        available_actions: LENDING_RUNTIME_ACTIONS.to_vec(),
        starting_balance: 10_000.0,
        starting_price: 100.0,
        simulation_boundaries: vec!["semantics lending.v1".into()],
        invariants: adapter.invariants.clone(),
        scheduled_actions: Vec::new(),
        semantics: adapter.semantics.clone(),
        errors: Vec::new(),
    };

    run_simulation(&mut harness, &mut scenario, params).unwrap()
}

#[test]
fn lending_v1_semantics_emit_derived_observations_and_expression_invariants() {
    let adapter = parse_adapter_str(semantic_lending_toml(), "semantic-lending.toml").unwrap();
    let cfg = RunConfig {
        agents: 1,
        ticks: 0,
        scenario: "baseline".into(),
        seed: 19,
        personas: vec!["semantic-lp".into()],
        validator_url: "unused".into(),
        output_path: "unused".into(),
    };
    let mut harness = MockHarness::new(1, 100.0).with_risk_params(7_000, 8_000);
    harness.seed_position(0, 10, 800);
    let mut scenario = BaselineScenario::new(100.0, 0);
    let params = SimulationParams {
        run_config: &cfg,
        policies: vec![policy()],
        agent_personas: vec![0],
        available_actions: LENDING_RUNTIME_ACTIONS.to_vec(),
        starting_balance: 10_000.0,
        starting_price: 100.0,
        simulation_boundaries: vec!["semantics lending.v1".into()],
        invariants: adapter.invariants.clone(),
        scheduled_actions: Vec::new(),
        semantics: adapter.semantics.clone(),
        errors: Vec::new(),
    };

    let result = run_simulation(&mut harness, &mut scenario, params).unwrap();
    let derived = result.timeseries[0]["derived_observations"]
        .as_object()
        .expect("derived_observations object");
    assert_eq!(derived["collateral_value"].as_u64(), Some(1_000));
    assert_eq!(derived["debt_value"].as_u64(), Some(800));
    assert_eq!(derived["max_borrow_value"].as_u64(), Some(700));
    assert_eq!(derived["health_factor"].as_u64(), Some(1));

    let expression_rows = result.summary["expression_invariants"]
        .as_array()
        .expect("expression_invariants summary");
    assert_eq!(expression_rows.len(), 2);
    assert_eq!(expression_rows[0]["name"], "bad_debt_bound");
    assert_eq!(expression_rows[0]["firings"].as_u64(), Some(0));
    assert_eq!(expression_rows[1]["name"], "ltv_below_max");
    assert_eq!(expression_rows[1]["severity"], "warn");
    assert_eq!(expression_rows[1]["firings"].as_u64(), Some(1));
    assert_eq!(expression_rows[1]["first_fired_tick"].as_u64(), Some(0));

    let fire = result
        .events
        .iter()
        .find(|event| event.action == "expression_invariant_fire:ltv_below_max")
        .expect("ltv_below_max fire event");
    assert_eq!(fire.params["expr"], "debt_value <= max_borrow_value");
    assert_eq!(fire.params["severity"], "warn");
    assert_eq!(
        fire.params["observed"]["max_borrow_value"].as_u64(),
        Some(700)
    );
}

#[test]
fn migrated_lending_adapter_runs_semantics_end_to_end() {
    let path = monorepo_root().join("fixtures/adapters/lending.toml");
    let adapter = load_adapter(&path).expect("load migrated lending adapter");
    let semantics = adapter
        .semantics
        .as_ref()
        .expect("shipping lending adapter opts into semantics");
    assert_eq!(semantics.class.as_deref(), Some("lending.v1"));
    for role in [
        "position",
        "reserve",
        "oracle",
        "usdc",
        "liquidation_config",
    ] {
        assert!(
            semantics.roles.contains_key(role),
            "missing required role {role}"
        );
    }
    for derived in [
        "collateral_value",
        "debt_value",
        "max_borrow_value",
        "health_factor",
    ] {
        assert!(
            semantics.derived.contains_key(derived),
            "missing required derived observation {derived}"
        );
    }
    assert_eq!(semantics.invariants.len(), 3);
    assert_eq!(
        semantics.oracles.get("usdc").map(Vec::len),
        Some(2),
        "shipping lending adapter should exercise two usdc oracle bindings"
    );
    assert!(semantics
        .oracles
        .get("usdc")
        .expect("usdc bindings")
        .iter()
        .all(|binding| binding.program_id == LENDING_PROGRAM_PUBKEY));
    assert!(
        semantics.collections.contains_key("worst_health_factor"),
        "shipping lending adapter should exercise the collection evaluator"
    );
    assert!(semantics
        .invariants
        .iter()
        .all(|invariant| invariant.severity.as_str() == "warn"));

    let harness = MockHarness::new(2, 100.0).with_risk_params(7_000, 8_000);
    let mut alice = Agent::new("alice", policy(), 0.0);
    alice.position.collateral = 1.0;
    alice.position.debt = 10.0;
    let mut bob = Agent::new("bob", policy(), 0.0);
    bob.position.collateral = 10.0;
    bob.position.debt = 800.0;
    let agents = vec![alice, bob];
    let snapshot: TickSnapshot =
        BTreeMap::from([("oracle_price".into(), serde_json::Value::from(100_u64))]);
    let mut role_context = bind_lending_v1_roles(
        semantics,
        &harness,
        &agents,
        &snapshot,
        RoleBindingContext::new(Some("borrow"), Some(1)),
    )
    .expect("bind migrated adapter roles from current instruction context");

    assert_eq!(
        role_context.get("position.collateral_amount"),
        Some(&SemanticValue::U128(10))
    );
    assert_eq!(
        role_context.get("position.debt_amount"),
        Some(&SemanticValue::U128(800))
    );
    for index in 0..2 {
        role_context.insert(format!("usdc.{index}.price"), SemanticValue::U128(100));
        role_context.insert(format!("usdc.{index}.confidence"), SemanticValue::U128(0));
        role_context.insert(format!("usdc.{index}.staleness"), SemanticValue::U128(0));
    }

    let derived = evaluate_derived_observations(semantics, &role_context)
        .expect("evaluate migrated adapter derived observations");
    assert_eq!(
        derived.observations.get("usdc.median_price"),
        Some(&SemanticValue::U128(100))
    );
    assert_eq!(
        derived.observations.get("collateral_value"),
        Some(&SemanticValue::U128(1_000))
    );
    assert_eq!(
        derived.observations.get("debt_value"),
        Some(&SemanticValue::U128(800))
    );
    assert_eq!(
        derived.observations.get("max_borrow_value"),
        Some(&SemanticValue::U128(700))
    );
    assert_eq!(
        derived.observations.get("liquidation_threshold_value"),
        Some(&SemanticValue::U128(800))
    );
    assert_eq!(
        derived.observations.get("health_factor"),
        Some(&SemanticValue::U128(1))
    );

    let mut expression_context = derived.context.clone();
    expression_context.insert(
        "collection.worst_health_factor".into(),
        SemanticValue::U128(2),
    );
    let fires = evaluate_expression_invariants(semantics, &expression_context, 0)
        .expect("evaluate migrated adapter expression invariants");
    assert_eq!(fires.len(), 1);
    assert_eq!(fires[0].name, "ltv_below_max");
    assert_eq!(fires[0].severity.as_str(), "warn");
    assert_eq!(
        fires[0].observed.get("max_borrow_value"),
        Some(&SemanticValue::U128(700))
    );
}

#[test]
fn lending_adapter_without_semantics_runs_legacy_mode() {
    let path = monorepo_root().join("fixtures/adapters/lending.toml");
    let raw = fs::read_to_string(&path).expect("read migrated lending adapter");
    let start = raw.find("\n[semantics]\n").expect("semantics block start");
    let end = raw
        .find("\n# Reviewer-facing lineage")
        .expect("lineage block remains after semantics");
    let legacy_raw = format!("{}{}", &raw[..start], &raw[end..]);
    let adapter =
        parse_adapter_str(&legacy_raw, "lending-without-semantics.toml").expect("legacy parse");
    assert!(adapter.semantics.is_none());

    let result = run_single_agent_semantic_lending(&adapter);
    assert!(
        result.timeseries[0].get("derived_observations").is_none(),
        "legacy mode must not emit derived_observations"
    );
    assert!(
        result.summary.get("expression_invariants").is_none(),
        "legacy mode must not emit expression_invariants"
    );
}

#[test]
fn migrated_lending_adapter_does_not_emit_semantics_on_idle_tick_snapshot() {
    let path = monorepo_root().join("fixtures/adapters/lending.toml");
    let adapter = load_adapter(&path).expect("load migrated lending adapter");

    let result = run_single_agent_semantic_lending(&adapter);
    assert!(
        result.timeseries[0].get("derived_observations").is_none(),
        "idle snapshots with instruction-bound semantics must not emit derived observations"
    );
    assert!(
        result.summary.get("expression_invariants").is_some(),
        "expression invariant definitions remain summarized even when idle ticks do not evaluate"
    );
}

#[test]
fn migrated_lending_adapter_binds_liquidation_semantics_to_borrower_target() {
    let path = monorepo_root().join("fixtures/adapters/lending.toml");
    let adapter = load_adapter(&path).expect("load migrated lending adapter");
    let cfg = RunConfig {
        agents: 2,
        ticks: 1,
        scenario: "shock".into(),
        seed: 19,
        personas: vec!["borrower".into(), "liquidator".into()],
        validator_url: "unused".into(),
        output_path: "unused".into(),
    };
    let borrower = Policy {
        persona_id: "borrower".into(),
        persona_label: "borrower".into(),
        action_rate_multiplier: 1.0,
        risk_tolerance: 0.5,
        action_weights: BTreeMap::from([
            ("deposit".into(), 0.0),
            ("borrow".into(), 0.0),
            ("withdraw".into(), 0.0),
            ("repay".into(), 0.0),
            ("liquidate".into(), 0.0),
        ]),
        triggers: vec![],
        position_sizing: PositionSizing {
            strategy: PositionSizingStrategy::Fixed,
            params: BTreeMap::from([("amount".into(), 0.0)]),
        },
        max_exposure: 1.0,
        persona_args: BTreeMap::new(),
    };
    let liquidator = Policy {
        persona_id: "liquidator".into(),
        persona_label: "liquidator".into(),
        action_rate_multiplier: 1.0,
        risk_tolerance: 0.5,
        action_weights: BTreeMap::from([
            ("deposit".into(), 0.0),
            ("borrow".into(), 0.0),
            ("withdraw".into(), 0.0),
            ("repay".into(), 0.0),
            ("liquidate".into(), 1.0),
        ]),
        triggers: vec![],
        position_sizing: PositionSizing {
            strategy: PositionSizingStrategy::Fixed,
            params: BTreeMap::from([("amount".into(), 100.0)]),
        },
        max_exposure: 0.1,
        persona_args: BTreeMap::new(),
    };
    let mut harness = MockHarness::new(2, 100.0)
        .with_risk_params(7_000, 8_000)
        .with_semantic_oracle(
            LENDING_SEMANTIC_ORACLE_PUBKEY,
            shipping_usdc_oracle_observation(),
        )
        .with_semantic_oracle_owner(LENDING_SEMANTIC_ORACLE_PUBKEY, LENDING_PROGRAM_PUBKEY);
    harness.seed_position(0, 10, 900);
    let mut scenario = PriceShockScenario::new(100.0, 0, 1, 0.5);
    let params = SimulationParams {
        run_config: &cfg,
        policies: vec![borrower, liquidator],
        agent_personas: vec![0, 1],
        available_actions: LENDING_RUNTIME_ACTIONS.to_vec(),
        starting_balance: 10_000.0,
        starting_price: 100.0,
        simulation_boundaries: vec!["liquidation semantic target".into()],
        invariants: adapter.invariants.clone(),
        scheduled_actions: Vec::new(),
        semantics: adapter.semantics.clone(),
        errors: Vec::new(),
    };

    let result = run_simulation(&mut harness, &mut scenario, params).unwrap();
    assert!(result.events.iter().any(|event| {
        event.action == "liquidate" && matches!(event.outcome, SimOutcome::Success)
    }));

    let derived = result.timeseries[1]["derived_observations"]
        .as_object()
        .expect("instruction-backed derived observations");
    assert_eq!(
        derived["debt_value"].as_u64(),
        Some(900),
        "liquidation semantics must bind the borrower target, not the debt-free liquidator"
    );
    assert!(result
        .events
        .iter()
        .any(|event| event.action == "expression_invariant_fire:ltv_below_max"));
}

#[test]
fn lending_replay_runs_derived_observations_and_expression_invariants() {
    let adapter =
        parse_adapter_str(semantic_lending_replay_toml(), "semantic-replay.toml").unwrap();
    let dir = make_temp_replay_dir("semantic-lending-replay");
    fs::write(
        dir.join("trajectory.json"),
        r#"{
  "metadata": { "name": "semantic-lending-replay" },
  "ticks": [
    {
      "tick": 0,
      "instructions": [
        { "name": "deposit", "agent": "alice", "args": { "amount": 1000 } },
        { "name": "borrow", "agent": "alice", "args": { "amount": 800 } }
      ]
    }
  ]
}
"#,
    )
    .expect("write trajectory");
    let bundle = load_replay_bundle(&dir, &adapter).expect("load replay bundle");
    let mut harness =
        MockHarness::new(bundle.actor_ids.len(), 100.0).with_risk_params(7_000, 8_000);

    let result =
        run_lending_replay(&mut harness, &adapter, &bundle, "unused".into()).expect("run replay");

    let derived = result.timeseries[0]["derived_observations"]
        .as_object()
        .expect("derived_observations object");
    assert_eq!(derived["collateral_value"].as_u64(), Some(100_000));
    assert_eq!(derived["debt_value"].as_u64(), Some(800));
    assert_eq!(derived["max_borrow_value"].as_u64(), Some(70_000));

    let expression_rows = result.summary["expression_invariants"]
        .as_array()
        .expect("expression_invariants summary");
    assert_eq!(expression_rows.len(), 1);
    assert_eq!(expression_rows[0]["name"], "replay_debt_bound");
    assert_eq!(expression_rows[0]["severity"], "error");
    assert_eq!(expression_rows[0]["firings"].as_u64(), Some(1));
    assert_eq!(expression_rows[0]["first_fired_tick"].as_u64(), Some(0));
    assert!(result
        .events
        .iter()
        .any(|event| event.action == "expression_invariant_fire:replay_debt_bound"));
}

#[test]
fn lending_replay_semantics_survive_multi_actor_idle_ticks_after_initial_state() {
    let adapter =
        parse_adapter_str(semantic_lending_replay_toml(), "semantic-replay.toml").unwrap();
    let dir = make_temp_replay_dir("semantic-lending-idle-replay");
    fs::write(
        dir.join("initial-state.json"),
        r#"{
  "instructions": [
    { "name": "deposit", "agent": "whale-0", "args": { "amount": 1000 } },
    { "name": "borrow", "agent": "whale-0", "args": { "amount": 800 } },
    { "name": "deposit", "agent": "whale-1", "args": { "amount": 1000 } },
    { "name": "borrow", "agent": "whale-1", "args": { "amount": 800 } }
  ]
}
"#,
    )
    .expect("write initial state");
    fs::write(
        dir.join("trajectory.json"),
        r#"{
  "metadata": { "name": "semantic-lending-idle-replay" },
  "ticks": [
    {
      "tick": 4,
      "instructions": [
        { "name": "liquidate", "agent": "liquidator-0", "args": { "amount": 800, "target": "whale-0" } }
      ]
    }
  ]
}
"#,
    )
    .expect("write trajectory");
    let bundle = load_replay_bundle(&dir, &adapter).expect("load replay bundle");
    let mut harness =
        MockHarness::new(bundle.actor_ids.len(), 100.0).with_risk_params(7_000, 8_000);

    let result =
        run_lending_replay(&mut harness, &adapter, &bundle, "unused".into()).expect("run replay");

    assert_eq!(result.timeseries.len(), 5);
    for tick in 0..=4 {
        let derived = result.timeseries[tick]["derived_observations"]
            .as_object()
            .expect("derived_observations object");
        assert_eq!(derived["debt_value"].as_u64(), Some(800));
    }

    let expression_rows = result.summary["expression_invariants"]
        .as_array()
        .expect("expression_invariants summary");
    assert_eq!(expression_rows[0]["firings"].as_u64(), Some(5));
    assert_eq!(expression_rows[0]["first_fired_tick"].as_u64(), Some(0));
}
