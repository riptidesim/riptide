use std::collections::BTreeMap;

use riptide_engine::{
    adapter::parse_adapter_str,
    agent::policy::LENDING_RUNTIME_ACTIONS,
    semantics::{
        collections::{
            evaluate_collection, evaluate_semantic_collections, worst::WorstDirectionError,
            CollectionEvaluationError, CollectionValueKind, RoleCollectionContexts,
        },
        Context, Value,
    },
    sim::{run_simulation, MockHarness, SimulationParams},
    types::{Policy, PositionSizing, PositionSizingStrategy, RunConfig},
};

const DEMO: &str = include_str!("fixtures/collection-demo.toml");

const PIPELINE_DEMO: &str = r#"
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
health_factor = "collateral_value / max(debt_value, 1)"

[semantics.collections.worst_health_factor]
over = "reserves"
formula = "worst"
expr = "health_factor"

[[semantics.invariants]]
name = "collection_health_guard"
expr = "collection.worst_health_factor > 1"
severity = "error"
"#;

const RUNTIME_RESERVES_DEMO: &str = r#"
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
fields.health_factor = "u128"

[semantics.roles.oracle]
source = "account.oracle"
fields.price = "u128"
fields.confidence = "u64"

[semantics.roles.liquidation_config]
source = "account.reserve"
fields.liquidation_threshold_bps = "u64"

[semantics.collections.worst_health_factor]
over = "reserves"
formula = "worst"
expr = "reserve.health_factor"

[[semantics.invariants]]
name = "runtime_collection_health_guard"
expr = "collection.worst_health_factor > 100"
severity = "error"
"#;

#[test]
fn semantics_collection_evaluates_sum_min_max_and_lending_worst() {
    let adapter = parse_adapter_str(DEMO, "collection-demo.toml").unwrap();
    let semantics = adapter.semantics.expect("semantics block");
    let role_collections = RoleCollectionContexts::from([(
        "reserves".to_string(),
        vec![
            reserve_context(100, 150, 180, 2, 30),
            reserve_context(200, 80, 110, 8, 92),
            reserve_context(300, 120, 140, 5, 55),
        ],
    )]);

    let values = evaluate_semantic_collections(&semantics, &role_collections).unwrap();

    assert_eq!(values["total_liquidity"].value, Value::U128(600));
    assert_eq!(values["total_liquidity"].samples, 3);
    assert_eq!(values["min_health_factor"].value, Value::U128(80));
    assert_eq!(values["max_utilization"].value, Value::U128(92));
    assert_eq!(values["worst_health_factor"].value, Value::U128(80));
    assert_eq!(values["worst_collateral_ratio"].value, Value::U128(110));
    assert_eq!(values["worst_bad_debt_ratio"].value, Value::U128(8));
    assert_eq!(values["worst_utilization"].value, Value::U128(92));
}

#[test]
fn semantics_collection_empty_collection_returns_typed_sentinel_error() {
    let adapter = parse_adapter_str(DEMO, "collection-demo.toml").unwrap();
    let semantics = adapter.semantics.expect("semantics block");
    let collection = semantics.collections.get("min_health_factor").unwrap();

    let err = evaluate_collection(
        semantics.class.as_deref(),
        "min_health_factor",
        collection,
        &[],
        CollectionValueKind::U128,
    )
    .unwrap_err();

    let CollectionEvaluationError::EmptyCollection {
        name,
        over,
        sentinel,
        ..
    } = err
    else {
        panic!("expected empty collection error");
    };
    assert_eq!(name, "min_health_factor");
    assert_eq!(over, "reserves");
    assert_eq!(sentinel.value_kind, CollectionValueKind::U128);
}

#[test]
fn semantics_collection_worst_returns_unknown_class_error_for_generic_semantics() {
    let adapter = parse_adapter_str(DEMO, "collection-demo.toml").unwrap();
    let semantics = adapter.semantics.expect("semantics block");
    let collection = semantics.collections.get("worst_health_factor").unwrap();

    let err = evaluate_collection(
        Some("generic.v1"),
        "worst_health_factor",
        collection,
        &[reserve_context(100, 150, 180, 2, 30)],
        CollectionValueKind::Unknown,
    )
    .unwrap_err();

    let CollectionEvaluationError::WorstDirection { error, .. } = err else {
        panic!("expected worst direction error");
    };
    assert_eq!(
        error,
        WorstDirectionError::UnknownSemanticClass {
            class: Some("generic.v1".into())
        }
    );
}

#[test]
fn semantics_collection_evaluation_errors_include_collection_name_and_item_index() {
    let adapter = parse_adapter_str(DEMO, "collection-demo.toml").unwrap();
    let semantics = adapter.semantics.expect("semantics block");
    let collection = semantics.collections.get("total_liquidity").unwrap();
    let contexts = vec![
        reserve_context(100, 150, 180, 2, 30),
        Context::new(),
        reserve_context(300, 120, 140, 5, 55),
    ];

    let err = evaluate_collection(
        semantics.class.as_deref(),
        "total_liquidity",
        collection,
        &contexts,
        CollectionValueKind::Unknown,
    )
    .unwrap_err();

    let CollectionEvaluationError::Evaluation { name, index, .. } = err else {
        panic!("expected expression evaluation error");
    };
    assert_eq!(name, "total_liquidity");
    assert_eq!(index, 1);
}

#[test]
fn semantics_collection_observations_feed_expression_invariants() {
    let adapter = parse_adapter_str(PIPELINE_DEMO, "collection-pipeline-demo.toml").unwrap();
    let cfg = RunConfig {
        agents: 1,
        ticks: 0,
        scenario: "baseline".into(),
        seed: 21,
        personas: vec!["collector".into()],
        validator_url: "unused".into(),
        output_path: "unused".into(),
    };
    let policy = Policy {
        persona_id: "collector".into(),
        persona_label: "collector".into(),
        action_rate_multiplier: 1.0,
        risk_tolerance: 0.5,
        action_weights: BTreeMap::new(),
        triggers: Vec::new(),
        position_sizing: PositionSizing {
            strategy: PositionSizingStrategy::Fixed,
            params: BTreeMap::new(),
        },
        max_exposure: 1.0,
        persona_args: BTreeMap::new(),
    };
    let mut harness = MockHarness::new(1, 100.0).with_risk_params(7_000, 8_000);
    harness.seed_position(0, 10, 800);
    let mut scenario = riptide_engine::scenario::BaselineScenario::new(100.0, 0);
    let params = SimulationParams {
        run_config: &cfg,
        policies: vec![policy],
        agent_personas: vec![0],
        available_actions: LENDING_RUNTIME_ACTIONS.to_vec(),
        starting_balance: 10_000.0,
        starting_price: 100.0,
        simulation_boundaries: vec!["collection semantics pipeline".into()],
        invariants: adapter.invariants.clone(),
        scheduled_actions: Vec::new(),
        semantics: adapter.semantics.clone(),
        errors: Vec::new(),
    };

    let result = run_simulation(&mut harness, &mut scenario, params).unwrap();
    let collection = result.timeseries[0]["collection_observations"]
        .as_object()
        .expect("collection observations object");
    assert_eq!(collection["worst_health_factor"].as_u64(), Some(1));
    assert!(result
        .events
        .iter()
        .any(|event| event.action == "expression_invariant_fire:collection_health_guard"));
}

#[test]
fn semantics_collection_tick_path_materializes_multiple_reserve_contexts() {
    let adapter = parse_adapter_str(
        RUNTIME_RESERVES_DEMO,
        "collection-runtime-reserves-demo.toml",
    )
    .unwrap();
    let cfg = RunConfig {
        agents: 1,
        ticks: 0,
        scenario: "baseline".into(),
        seed: 21,
        personas: vec!["collector".into()],
        validator_url: "unused".into(),
        output_path: "unused".into(),
    };
    let policy = Policy {
        persona_id: "collector".into(),
        persona_label: "collector".into(),
        action_rate_multiplier: 1.0,
        risk_tolerance: 0.5,
        action_weights: BTreeMap::new(),
        triggers: Vec::new(),
        position_sizing: PositionSizing {
            strategy: PositionSizingStrategy::Fixed,
            params: BTreeMap::new(),
        },
        max_exposure: 1.0,
        persona_args: BTreeMap::new(),
    };
    let mut harness = MockHarness::new(1, 100.0).with_semantic_collection_contexts(
        "reserves",
        vec![
            reserve_context(100, 80, 110, 2, 30),
            reserve_context(200, 150, 180, 0, 55),
        ],
    );
    let mut scenario = riptide_engine::scenario::BaselineScenario::new(100.0, 0);
    let params = SimulationParams {
        run_config: &cfg,
        policies: vec![policy],
        agent_personas: vec![0],
        available_actions: LENDING_RUNTIME_ACTIONS.to_vec(),
        starting_balance: 10_000.0,
        starting_price: 100.0,
        simulation_boundaries: vec!["collection semantics runtime".into()],
        invariants: adapter.invariants.clone(),
        scheduled_actions: Vec::new(),
        semantics: adapter.semantics.clone(),
        errors: Vec::new(),
    };

    let result = run_simulation(&mut harness, &mut scenario, params).unwrap();
    let collection = result.timeseries[0]["collection_observations"]
        .as_object()
        .expect("collection observations object");
    assert_eq!(collection["worst_health_factor"].as_u64(), Some(80));
    assert!(result.events.iter().any(|event| {
        event.action == "expression_invariant_fire:runtime_collection_health_guard"
    }));
}

#[test]
fn semantics_collection_empty_runtime_collection_does_not_abort_expression_invariant() {
    let adapter = parse_adapter_str(
        RUNTIME_RESERVES_DEMO,
        "collection-runtime-empty-reserves-demo.toml",
    )
    .unwrap();
    let cfg = RunConfig {
        agents: 1,
        ticks: 0,
        scenario: "baseline".into(),
        seed: 21,
        personas: vec!["collector".into()],
        validator_url: "unused".into(),
        output_path: "unused".into(),
    };
    let policy = Policy {
        persona_id: "collector".into(),
        persona_label: "collector".into(),
        action_rate_multiplier: 1.0,
        risk_tolerance: 0.5,
        action_weights: BTreeMap::new(),
        triggers: Vec::new(),
        position_sizing: PositionSizing {
            strategy: PositionSizingStrategy::Fixed,
            params: BTreeMap::new(),
        },
        max_exposure: 1.0,
        persona_args: BTreeMap::new(),
    };
    let mut harness =
        MockHarness::new(1, 100.0).with_semantic_collection_contexts("reserves", Vec::new());
    let mut scenario = riptide_engine::scenario::BaselineScenario::new(100.0, 0);
    let params = SimulationParams {
        run_config: &cfg,
        policies: vec![policy],
        agent_personas: vec![0],
        available_actions: LENDING_RUNTIME_ACTIONS.to_vec(),
        starting_balance: 10_000.0,
        starting_price: 100.0,
        simulation_boundaries: vec!["empty collection semantics runtime".into()],
        invariants: adapter.invariants.clone(),
        scheduled_actions: Vec::new(),
        semantics: adapter.semantics.clone(),
        errors: Vec::new(),
    };

    let result = run_simulation(&mut harness, &mut scenario, params).unwrap();
    let sentinel = &result.timeseries[0]["collection_observations"]["worst_health_factor"];
    assert_eq!(sentinel["evaluation_error"][0]["type"], "EmptyCollection");
    let fire = result
        .events
        .iter()
        .find(|event| event.action == "expression_invariant_fire:runtime_collection_health_guard")
        .expect("empty collection sentinel should keep expression invariant evaluation alive");
    assert_eq!(fire.params["observed"]["collection.worst_health_factor"], 0);
}

fn reserve_context(
    liquidity: u128,
    health_factor: u128,
    collateral_ratio: u128,
    bad_debt_ratio: u128,
    utilization: u128,
) -> Context {
    BTreeMap::from([
        ("reserve.liquidity".to_string(), Value::U128(liquidity)),
        (
            "reserve.health_factor".to_string(),
            Value::U128(health_factor),
        ),
        (
            "reserve.collateral_ratio".to_string(),
            Value::U128(collateral_ratio),
        ),
        (
            "reserve.bad_debt_ratio".to_string(),
            Value::U128(bad_debt_ratio),
        ),
        ("reserve.utilization".to_string(), Value::U128(utilization)),
    ])
}
