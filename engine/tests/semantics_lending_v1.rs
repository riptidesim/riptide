use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use riptide_engine::{
    adapter::parse_adapter_str,
    agent::policy::LENDING_RUNTIME_ACTIONS,
    replay::{load_replay_bundle, run_lending_replay},
    scenario::BaselineScenario,
    sim::{run_simulation, MockHarness, SimulationParams},
    types::{Policy, PositionSizing, PositionSizingStrategy, RunConfig, Trigger, TriggerCondition},
};

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
