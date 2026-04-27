use riptide_engine::adapter::{decode_program_error, parse_adapter_str};

#[test]
fn adapter_errors_decode_custom_program_error() {
    let toml = r#"
protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"

[[errors]]
code = 8
label = "insufficient_collateral"
interpretation = "Borrow or withdraw exceeded the position collateral constraint."
"#;

    let adapter = parse_adapter_str(toml, "errors.toml").expect("adapter parses");
    let decoded = decode_program_error(&adapter.errors, Some("InstructionError(0, Custom(8))"))
        .expect("custom code is extracted");

    assert_eq!(decoded.code, 8);
    assert_eq!(decoded.label.as_deref(), Some("insufficient_collateral"));
    assert_eq!(
        decoded.interpretation.as_deref(),
        Some("Borrow or withdraw exceeded the position collateral constraint.")
    );
}

#[test]
fn unknown_custom_program_error_falls_back_to_code_only() {
    let decoded = decode_program_error(&[], Some("InstructionError(0, Custom(99))"))
        .expect("custom code is extracted");
    assert_eq!(decoded.code, 99);
    assert_eq!(decoded.label, None);
    assert_eq!(decoded.interpretation, None);
}

#[test]
fn duplicate_error_code_is_rejected() {
    let toml = r#"
protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"

[[errors]]
code = 8
label = "insufficient_collateral"
interpretation = "Borrow or withdraw exceeded the position collateral constraint."

[[errors]]
code = 8
label = "insufficient_liquidity"
interpretation = "Pool liquidity was insufficient."
"#;

    let err = parse_adapter_str(toml, "errors.toml").unwrap_err();
    assert!(
        err.to_string().contains("duplicate program error code `8`"),
        "{err}"
    );
}
