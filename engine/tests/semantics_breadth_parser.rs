use riptide_engine::adapter::{
    parse_adapter_str, AdapterError, CollectionFormula, ReplayStateSource,
};

const DEMO: &str = include_str!("fixtures/semantics-breadth-demo.toml");
const LEGACY_LENDING: &str = include_str!("../../fixtures/adapters/lending.toml");

#[test]
fn semantics_breadth_parser_accepts_oracles_collections_and_replay() {
    let adapter = parse_adapter_str(DEMO, "semantics-breadth-demo.toml").unwrap();
    let semantics = adapter.semantics.expect("semantics block");

    let oracle_bindings = semantics.oracles.get("oracle").expect("oracle role");
    assert_eq!(oracle_bindings.len(), 2);
    assert_eq!(oracle_bindings[0].weight, Some(60));
    assert_eq!(oracle_bindings[1].weight, Some(40));
    assert_eq!(oracle_bindings[0].confidence, "oracle.confidence");
    assert_eq!(oracle_bindings[1].staleness, "oracle.staleness");

    let collection = semantics
        .collections
        .get("worst_health_factor")
        .expect("collection");
    assert_eq!(collection.over, "reserves");
    assert_eq!(collection.formula_ref, Some(CollectionFormula::Worst));
    assert!(collection.expr_ast.is_some());

    let replay = semantics.replay.expect("replay block");
    assert_eq!(replay.state_source_ref, Some(ReplayStateSource::Fixture));
    assert_eq!(
        replay.pack_path.as_deref(),
        Some("state-packs/semantics-breadth-demo")
    );
    assert_eq!(replay.slot, Some(123456789));
    assert_eq!(replay.roles.len(), 4);
}

#[test]
fn semantics_breadth_parser_accepts_mainnet_rpc_without_parse_time_error() {
    let toml = DEMO.replace(
        "state_source = \"fixture\"",
        "state_source = \"mainnet-rpc\"",
    );
    let adapter = parse_adapter_str(&toml, "semantics-mainnet-rpc.toml").unwrap();
    let replay = adapter.semantics.unwrap().replay.unwrap();

    assert_eq!(replay.state_source_ref, Some(ReplayStateSource::MainnetRpc));
}

#[test]
fn semantics_breadth_parser_rejects_unknown_oracle_role() {
    let toml = DEMO.replace(
        "[[semantics.oracles.oracle]]",
        "[[semantics.oracles.price_feed]]",
    );
    let err = parse_adapter_str(&toml, "semantics-bad-oracle-role.toml").unwrap_err();
    assert!(matches!(err, AdapterError::UnknownOracleRole { .. }));
}

#[test]
fn semantics_breadth_parser_rejects_partial_oracle_weights() {
    let toml = DEMO.replace("weight = 40\n", "");
    let err = parse_adapter_str(&toml, "semantics-partial-weights.toml").unwrap_err();
    assert!(matches!(err, AdapterError::MultiOracleArityMismatch { .. }));
}

#[test]
fn semantics_breadth_parser_rejects_zero_sum_oracle_weights() {
    let toml = DEMO
        .replace("weight = 60", "weight = 0")
        .replace("weight = 40", "weight = 0");
    let err = parse_adapter_str(&toml, "semantics-zero-weights.toml").unwrap_err();
    assert!(matches!(
        err,
        AdapterError::MultiOracleWeightsAllZero { .. }
    ));
}

#[test]
fn semantics_breadth_parser_rejects_unknown_collection_formula() {
    let toml = DEMO.replace("formula = \"worst\"", "formula = \"median\"");
    let err = parse_adapter_str(&toml, "semantics-bad-formula.toml").unwrap_err();
    assert!(matches!(err, AdapterError::UnknownCollectionFormula { .. }));
}

#[test]
fn semantics_breadth_parser_rejects_collection_expression_parse_error() {
    let toml = DEMO.replace(
        "expr = \"collateral_value / max(debt_value, 1)\"",
        "expr = \"collateral_value /\"",
    );
    let err = parse_adapter_str(&toml, "semantics-bad-collection-expr.toml").unwrap_err();
    assert!(matches!(
        err,
        AdapterError::CollectionExpressionParse { .. }
    ));
}

#[test]
fn semantics_breadth_parser_rejects_unknown_replay_state_source() {
    let toml = DEMO.replace("state_source = \"fixture\"", "state_source = \"archive\"");
    let err = parse_adapter_str(&toml, "semantics-bad-replay-source.toml").unwrap_err();
    assert!(matches!(err, AdapterError::UnknownReplayStateSource { .. }));
}

#[test]
fn semantics_breadth_parser_rejects_missing_fixture_pack_path() {
    let toml = DEMO.replace("pack_path = \"state-packs/semantics-breadth-demo\"\n", "");
    let err = parse_adapter_str(&toml, "semantics-missing-pack.toml").unwrap_err();
    assert!(matches!(err, AdapterError::MissingReplayPackPath { .. }));
}

#[test]
fn semantics_breadth_parser_keeps_legacy_semantics_shape_additive() {
    let adapter = parse_adapter_str(LEGACY_LENDING, "fixtures/adapters/lending.toml").unwrap();
    let reparsed = parse_adapter_str(LEGACY_LENDING, "fixtures/adapters/lending.toml").unwrap();
    assert_eq!(adapter, reparsed);

    let semantics = adapter.semantics.expect("legacy lending semantics");
    assert!(semantics.oracles.is_empty());
    assert!(semantics.collections.is_empty());
    assert!(semantics.replay.is_none());

    let serialized = toml::to_string(&semantics).expect("serialize semantics");
    assert!(!serialized.contains("oracles"));
    assert!(!serialized.contains("collections"));
    assert!(!serialized.contains("replay"));
}
