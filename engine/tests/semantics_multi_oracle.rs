use std::collections::BTreeMap;

use riptide_engine::{
    adapter::{parse_adapter_str, AdapterError},
    agent::policy::LENDING_RUNTIME_ACTIONS,
    primitive::SemanticOracleObservation,
    semantics::{derived::evaluate_derived_observations, Value},
    sim::{run_simulation, MockHarness, SimulationParams},
    types::{Policy, PositionSizing, PositionSizingStrategy, RunConfig},
};

const DEMO: &str = include_str!("fixtures/multi-oracle-demo.toml");
const ORACLE_A: &str = "So11111111111111111111111111111111111111112";
const ORACLE_B: &str = "SysvarC1ock11111111111111111111111111111111";
const SYSTEM_PROGRAM_ID: &str = "11111111111111111111111111111111";
const SPL_TOKEN_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

#[test]
fn semantics_multi_oracle_derived_inputs_and_weighted_synthetic_are_available() {
    let adapter = parse_adapter_str(DEMO, "multi-oracle-demo.toml").unwrap();
    let semantics = adapter.semantics.as_ref().expect("semantics");
    let context = BTreeMap::from([
        ("position.collateral_amount".into(), Value::U128(10)),
        ("position.debt_amount".into(), Value::U128(800)),
        ("reserve.max_ltv_bps".into(), Value::U128(7_000)),
        ("reserve.collateral_price".into(), Value::U128(100)),
        (
            "liquidation_config.liquidation_threshold_bps".into(),
            Value::U128(8_000),
        ),
        ("oracle.price".into(), Value::U128(100)),
        ("oracle.0.price".into(), Value::U128(80)),
        ("oracle.1.price".into(), Value::U128(120)),
        ("oracle.0.confidence".into(), Value::U128(5)),
        ("oracle.1.confidence".into(), Value::U128(7)),
        ("oracle.0.staleness".into(), Value::U128(2)),
        ("oracle.1.staleness".into(), Value::U128(3)),
    ]);

    let result = evaluate_derived_observations(semantics, &context).unwrap();

    assert_eq!(
        result.observations.get("oracle.weighted_price"),
        Some(&Value::U128(90))
    );
    assert_eq!(
        result.observations.get("first_oracle_price"),
        Some(&Value::U128(80))
    );
    assert_eq!(
        result.observations.get("second_oracle_price"),
        Some(&Value::U128(120))
    );
    assert_eq!(
        result.observations.get("first_oracle_confidence"),
        Some(&Value::U128(5))
    );
    assert_eq!(
        result.observations.get("first_oracle_staleness"),
        Some(&Value::U128(2))
    );
    assert_eq!(
        result.observations.get("weighted_collateral_value"),
        Some(&Value::U128(900))
    );
}

#[test]
fn semantics_multi_oracle_default_emits_median_price() {
    let toml = DEMO
        .replace("weight = 3\n", "")
        .replace("weight = 1\n", "")
        .replace("oracle.weighted_price", "oracle.median_price");
    let adapter = parse_adapter_str(&toml, "multi-oracle-median-demo.toml").unwrap();
    let semantics = adapter.semantics.as_ref().expect("semantics");
    let context = BTreeMap::from([
        ("position.collateral_amount".into(), Value::U128(10)),
        ("position.debt_amount".into(), Value::U128(800)),
        ("reserve.max_ltv_bps".into(), Value::U128(7_000)),
        ("reserve.collateral_price".into(), Value::U128(100)),
        (
            "liquidation_config.liquidation_threshold_bps".into(),
            Value::U128(8_000),
        ),
        ("oracle.price".into(), Value::U128(100)),
        ("oracle.0.price".into(), Value::U128(80)),
        ("oracle.1.price".into(), Value::U128(120)),
        ("oracle.0.confidence".into(), Value::U128(5)),
        ("oracle.1.confidence".into(), Value::U128(7)),
        ("oracle.0.staleness".into(), Value::U128(2)),
        ("oracle.1.staleness".into(), Value::U128(3)),
    ]);

    let result = evaluate_derived_observations(semantics, &context).unwrap();

    assert_eq!(
        result.observations.get("oracle.median_price"),
        Some(&Value::U128(100))
    );
}

#[test]
fn semantics_multi_oracle_tick_path_reads_declared_accounts_by_index() {
    let adapter = parse_adapter_str(DEMO, "multi-oracle-demo.toml").unwrap();
    let cfg = RunConfig {
        agents: 1,
        ticks: 0,
        scenario: "baseline".into(),
        seed: 21,
        personas: vec!["oracle-reader".into()],
        validator_url: "unused".into(),
        output_path: "unused".into(),
    };
    let policy = Policy {
        persona_id: "oracle-reader".into(),
        persona_label: "oracle-reader".into(),
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
    let mut harness = MockHarness::new(1, 100.0)
        .with_semantic_oracle(
            ORACLE_A,
            SemanticOracleObservation {
                price: 80,
                confidence: 5,
                staleness: 2,
                exponent: 0,
            },
        )
        .with_semantic_oracle_owner(ORACLE_A, SYSTEM_PROGRAM_ID)
        .with_semantic_oracle(
            ORACLE_B,
            SemanticOracleObservation {
                price: 120,
                confidence: 7,
                staleness: 3,
                exponent: 0,
            },
        )
        .with_semantic_oracle_owner(ORACLE_B, SPL_TOKEN_PROGRAM_ID);
    let mut scenario = riptide_engine::scenario::BaselineScenario::new(100.0, 0);
    let params = SimulationParams {
        run_config: &cfg,
        policies: vec![policy],
        agent_personas: vec![0],
        available_actions: LENDING_RUNTIME_ACTIONS.to_vec(),
        starting_balance: 10_000.0,
        starting_price: 100.0,
        simulation_boundaries: vec!["multi-oracle semantics runtime".into()],
        invariants: adapter.invariants.clone(),
        scheduled_actions: Vec::new(),
        semantics: adapter.semantics.clone(),
        errors: Vec::new(),
    };

    let result = run_simulation(&mut harness, &mut scenario, params).unwrap();
    let derived = result.timeseries[0]["derived_observations"]
        .as_object()
        .expect("derived observations object");

    assert_eq!(derived["oracle.weighted_price"].as_u64(), Some(90));
    assert_eq!(derived["first_oracle_price"].as_u64(), Some(80));
    assert_eq!(derived["second_oracle_price"].as_u64(), Some(120));
    assert_eq!(derived["first_oracle_confidence"].as_u64(), Some(5));
    assert_eq!(derived["first_oracle_staleness"].as_u64(), Some(2));
}

#[test]
fn semantics_multi_oracle_tick_path_rejects_wrong_valid_program_id() {
    let toml = DEMO.replacen(
        "program_id = \"11111111111111111111111111111111\"",
        "program_id = \"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA\"",
        1,
    );
    let adapter = parse_adapter_str(&toml, "multi-oracle-wrong-owner-demo.toml").unwrap();
    let cfg = RunConfig {
        agents: 1,
        ticks: 0,
        scenario: "baseline".into(),
        seed: 21,
        personas: vec!["oracle-reader".into()],
        validator_url: "unused".into(),
        output_path: "unused".into(),
    };
    let policy = Policy {
        persona_id: "oracle-reader".into(),
        persona_label: "oracle-reader".into(),
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
    let mut harness = MockHarness::new(1, 100.0)
        .with_semantic_oracle(
            ORACLE_A,
            SemanticOracleObservation {
                price: 80,
                confidence: 5,
                staleness: 2,
                exponent: 0,
            },
        )
        .with_semantic_oracle_owner(ORACLE_A, SYSTEM_PROGRAM_ID);
    let mut scenario = riptide_engine::scenario::BaselineScenario::new(100.0, 0);
    let params = SimulationParams {
        run_config: &cfg,
        policies: vec![policy],
        agent_personas: vec![0],
        available_actions: LENDING_RUNTIME_ACTIONS.to_vec(),
        starting_balance: 10_000.0,
        starting_price: 100.0,
        simulation_boundaries: vec!["multi-oracle semantics runtime".into()],
        invariants: adapter.invariants.clone(),
        scheduled_actions: Vec::new(),
        semantics: adapter.semantics.clone(),
        errors: Vec::new(),
    };

    let err = run_simulation(&mut harness, &mut scenario, params).unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("OracleProgramIdMismatch(oracle.0)"),
        "wrong-but-valid oracle program_id must be load-bearing; got: {msg}"
    );
}

#[test]
fn semantics_multi_oracle_zero_weights_stay_fail_closed() {
    let toml = DEMO
        .replace("weight = 3", "weight = 0")
        .replace("weight = 1", "weight = 0");
    let err = parse_adapter_str(&toml, "multi-oracle-zero-weight-demo.toml").unwrap_err();

    assert!(matches!(
        err,
        AdapterError::MultiOracleWeightsAllZero { .. }
    ));
}

#[test]
fn semantics_multi_oracle_legacy_semantics_without_oracle_block_remains_on_legacy_path() {
    let mut adapter = parse_adapter_str(DEMO, "multi-oracle-demo.toml").unwrap();
    let semantics = adapter.semantics.as_mut().expect("semantics");
    semantics.oracles.clear();
    semantics.derived.clear();
    semantics.derived.insert(
        "legacy_price".into(),
        riptide_engine::adapter::SemanticExpression::new("oracle.price".into()),
    );
    let parsed = riptide_engine::semantics::expr::parse("oracle.price").unwrap();
    semantics
        .derived
        .get_mut("legacy_price")
        .expect("legacy expression")
        .ast = Some(parsed);
    semantics.derived_order = vec!["legacy_price".into()];

    let context = BTreeMap::from([("oracle.price".into(), Value::U128(100))]);
    let result = evaluate_derived_observations(semantics, &context).unwrap();

    assert_eq!(
        result.observations.get("legacy_price"),
        Some(&Value::U128(100))
    );
    assert!(!result.observations.contains_key("oracle.weighted_price"));
    assert!(!result.observations.contains_key("oracle.median_price"));
}
