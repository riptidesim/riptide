use riptide_engine::adapter::{
    parse_adapter_str, AdapterError, SemanticInvariantSeverity, SemanticSourceBinding,
};

fn valid_semantics_toml() -> &'static str {
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
source = "instruction.deposit"
fields.collateral_amount = "u128"
fields.debt_amount = "u128"

[semantics.roles.reserve]
source = "account.reserve"
fields.collateral_price = "u128"
fields.max_ltv_bps = "u64"

[semantics.roles.oracle]
source = "account.oracle"
fields.price = "u128"

[semantics.roles.liquidation_config]
source = "account.reserve"
fields.liquidation_threshold_bps = "u64"

[semantics.derived]
collateral_value = "position.collateral_amount * reserve.collateral_price / 10000"
debt_value = "position.debt_amount"
max_borrow_value = "collateral_value * reserve.max_ltv_bps / 10000"
health_factor = "collateral_value * 10000 / debt_value"

[[semantics.invariants]]
name = "bad_debt_bound"
expr = "debt_value <= collateral_value"
severity = "warn"
description = "Position must not be underwater"

[[semantics.invariants]]
name = "ltv_below_max"
expr = "debt_value <= max_borrow_value"
"#
}

#[test]
fn semantics_schema_round_trip_parses_ast_and_roles() {
    let adapter = parse_adapter_str(valid_semantics_toml(), "semantics.toml").unwrap();
    let semantics = adapter.semantics.expect("semantics present");

    assert_eq!(semantics.class.as_deref(), Some("lending.v1"));
    assert!(semantics.class_ref.is_some());
    assert_eq!(
        semantics.derived_order,
        vec![
            "collateral_value",
            "debt_value",
            "health_factor",
            "max_borrow_value"
        ],
        "loader should store a deterministic derived-observation order"
    );

    let reserve = semantics.roles.get("reserve").expect("reserve role");
    assert_eq!(
        reserve.binding,
        Some(SemanticSourceBinding::Account("reserve".to_string()))
    );
    assert!(reserve.fields.contains_key("collateral_price"));

    let health = semantics
        .derived
        .get("health_factor")
        .expect("health_factor derived expression");
    assert!(health.ast.is_some(), "loader should parse derived AST");
    assert_eq!(health.span.unwrap().start, 0);

    assert_eq!(semantics.invariants.len(), 2);
    assert_eq!(
        semantics.invariants[0].severity,
        SemanticInvariantSeverity::Warn
    );
    assert_eq!(
        semantics.invariants[1].severity,
        SemanticInvariantSeverity::Error,
        "severity defaults to error"
    );
    assert!(
        semantics.invariants[1].expr.ast.is_some(),
        "loader should parse invariant AST"
    );
}

#[test]
fn semantics_schema_rejects_missing_class() {
    let toml = valid_semantics_toml().replace("class = \"lending.v1\"\n", "");
    let err = parse_adapter_str(&toml, "semantics.toml").unwrap_err();
    assert!(matches!(err, AdapterError::MissingSemanticClass { .. }));
}

#[test]
fn semantics_schema_rejects_malformed_class_string() {
    let toml = valid_semantics_toml().replace("lending.v1", "Lending.v1");
    let err = parse_adapter_str(&toml, "semantics.toml").unwrap_err();
    assert!(matches!(err, AdapterError::MalformedSemanticClass { .. }));
}

#[test]
fn semantics_schema_rejects_unknown_class() {
    let toml = valid_semantics_toml().replace("lending.v1", "amm.v1");
    let err = parse_adapter_str(&toml, "semantics.toml").unwrap_err();
    assert!(matches!(err, AdapterError::UnknownSemanticClass { .. }));
}

#[test]
fn semantics_schema_rejects_lending_v1_on_generic_protocol() {
    let toml = valid_semantics_toml().replace("protocol = \"lending\"", "protocol = \"generic\"");
    let err = parse_adapter_str(&toml, "semantics.toml").unwrap_err();
    let AdapterError::Validation { key, reason, .. } = err else {
        panic!("expected protocol/class compatibility validation error");
    };
    assert_eq!(key, "[semantics].class");
    assert!(reason.contains("protocol = \"lending\""));
    assert!(reason.contains("no semantics evaluator"));
}

#[test]
fn semantics_schema_rejects_malformed_expression_with_span() {
    let toml = valid_semantics_toml().replace(
        "health_factor = \"collateral_value * 10000 / debt_value\"",
        "health_factor = \"collateral_value *\"",
    );
    let err = parse_adapter_str(&toml, "semantics.toml").unwrap_err();
    let AdapterError::MalformedSemanticExpression { key, source, .. } = err else {
        panic!("expected malformed semantic expression");
    };
    assert!(key.contains("health_factor"));
    assert!(source.span.start <= source.span.end);
}

#[test]
fn semantics_schema_rejects_duplicate_invariant_names() {
    let toml = valid_semantics_toml().replace("ltv_below_max", "bad_debt_bound");
    let err = parse_adapter_str(&toml, "semantics.toml").unwrap_err();
    assert!(matches!(err, AdapterError::DuplicateSemanticName { .. }));
}

#[test]
fn semantics_schema_rejects_derived_observation_cycles() {
    let toml = valid_semantics_toml().replace(
        r#"collateral_value = "position.collateral_amount * reserve.collateral_price / 10000"
debt_value = "position.debt_amount"
max_borrow_value = "collateral_value * reserve.max_ltv_bps / 10000"
health_factor = "collateral_value * 10000 / debt_value""#,
        r#"collateral_value = "health_factor + 1"
debt_value = "position.debt_amount"
max_borrow_value = "collateral_value * reserve.max_ltv_bps / 10000"
health_factor = "collateral_value + 1""#,
    );
    let err = parse_adapter_str(&toml, "semantics.toml").unwrap_err();
    assert!(matches!(err, AdapterError::DerivedObservationCycle { .. }));
}

#[test]
fn semantics_schema_rejects_unknown_source_binding_type() {
    let toml = valid_semantics_toml().replace("account.oracle", "wallet.oracle");
    let err = parse_adapter_str(&toml, "semantics.toml").unwrap_err();
    assert!(matches!(
        err,
        AdapterError::UnknownSemanticSourceBinding { .. }
    ));
}

#[test]
fn semantics_schema_rejects_missing_required_role() {
    let toml = valid_semantics_toml().replace(
        r#"[semantics.roles.oracle]
source = "account.oracle"
fields.price = "u128"

"#,
        "",
    );
    let err = parse_adapter_str(&toml, "semantics.toml").unwrap_err();
    assert!(matches!(
        err,
        AdapterError::MissingRequiredSemanticRole { .. }
    ));
}

#[test]
fn semantics_schema_diagnostics_escape_terminal_controls() {
    let cases = [
        (
            "semantic class",
            valid_semantics_toml().replace(
                "class = \"lending.v1\"",
                "class = \"lend\\u001bing.v1\"",
            ),
        ),
        (
            "semantic source",
            valid_semantics_toml().replace(
                "source = \"account.oracle\"",
                "source = \"\\u001b[2Jwallet.position\"",
            ),
        ),
        (
            "semantic role name",
            valid_semantics_toml().replace(
                "[semantics.derived]",
                "[semantics.roles.\"bad\\u001brole\"]\nsource = \"account.reserve\"\nfields.amount = \"u128\"\n\n[semantics.derived]",
            ),
        ),
        (
            "semantic field name",
            valid_semantics_toml().replace(
                "fields.debt_amount = \"u128\"",
                "fields.\"bad\\u001bfield\" = \"u128\"",
            ),
        ),
        (
            "semantic derived name",
            valid_semantics_toml().replace(
                "health_factor = \"collateral_value * 10000 / debt_value\"",
                "\"bad\\u001bderived\" = \"collateral_value * 10000 / debt_value\"",
            ),
        ),
        (
            "semantic invariant name",
            valid_semantics_toml().replace(
                "name = \"bad_debt_bound\"",
                "name = \"bad\\u001binvariant\"",
            ),
        ),
    ];

    for (label, toml) in cases {
        let err = match parse_adapter_str(&toml, "semantics.toml") {
            Ok(_) => panic!("{label} should be rejected"),
            Err(err) => err,
        };
        let msg = err.to_string();
        assert!(
            !contains_terminal_control(&msg),
            "{label} diagnostic preserved terminal controls: {msg:?}"
        );
        assert!(
            msg.contains("\\u{1b}"),
            "{label} diagnostic should escape the injected ESC byte: {msg}"
        );
    }
}

fn contains_terminal_control(value: &str) -> bool {
    value.chars().any(|ch| {
        let code = ch as u32;
        code < 0x20 || code == 0x7f || (0x80..0xa0).contains(&code)
    })
}

#[test]
fn non_lending_legacy_adapters_without_semantics_still_parse() {
    let fixtures = [
        (
            "perpetuals.toml",
            include_str!("../../fixtures/adapters/perpetuals.toml"),
        ),
        ("amm.toml", include_str!("../../fixtures/adapters/amm.toml")),
        (
            "liquid-staking.toml",
            include_str!("../../fixtures/adapters/liquid-staking.toml"),
        ),
        (
            "stablecoin.toml",
            include_str!("../../fixtures/adapters/stablecoin.toml"),
        ),
    ];

    for (name, toml) in fixtures {
        let adapter = parse_adapter_str(toml, name)
            .unwrap_or_else(|err| panic!("legacy adapter {name} should parse: {err}"));
        assert!(adapter.semantics.is_none(), "{name} should stay legacy");
    }
}
