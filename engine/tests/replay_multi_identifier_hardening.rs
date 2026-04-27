//! Multi-component replay identifier hardening.
//!
//! The parser splices component / bridge / target_oracle / source_field
//! names into qualified snapshot keys (`<component>.<field>`),
//! namespaced event ids (`<component>:<agent>`, `bridge:<name>`),
//! reviewer-facing pack trace rows, and (via the CLI) the default
//! artifact output directory. Left unconstrained those strings let a
//! malicious or sloppy config:
//!
//! - forge ambiguous qualified keys — `component = "a.b"` + field `c`
//!   collides with `component = "a"` + field `b.c`, silently breaking
//!   the qualified-namespace guarantee the multi-component surface
//!   sells;
//! - smuggle ANSI escape / newline / other control bytes into pack
//!   trace rows and CLI output;
//! - escape the default `riptide-output/replays/...` artifact subtree
//!   when the CLI derives the output directory from component names
//!   containing `..` or path separators.
//!
//! The parser now rejects every one of those shapes up front with a
//! named diagnostic. These tests pin each rejection path so the hole
//! cannot silently re-open.

use riptide_engine::replay::parse_replay_config;

fn multi_config_with_component_name(name: &str) -> String {
    // Use serde_json to encode the name as a proper JSON string so
    // control characters land as `\uNNNN` escapes (the JSON spec),
    // not the Rust-debug `\u{NN}` form that serde_json would reject
    // as invalid syntax.
    let json_name = serde_json::to_string(name).expect("encode name");
    format!(
        r#"{{
            "components": [
                {{ "name": {json_name},
                   "adapter": "/tmp/a/adapter.toml",
                   "trajectory_dir": "/tmp/a" }},
                {{ "name": "lending",
                   "adapter": "/tmp/b/adapter.toml",
                   "trajectory_dir": "/tmp/b" }}
            ],
            "output_path": "riptide-output/replays/x"
        }}"#,
    )
}

#[test]
fn rejects_component_name_with_dot_to_prevent_qualified_key_collisions() {
    // `component = "a.b"` plus field `c` would produce the qualified
    // key `a.b.c`, which is indistinguishable from the legitimate
    // `component = "a"` + field `b.c` case. Fail-closed before the
    // ambiguity lands.
    let raw = multi_config_with_component_name("liquid.staking");
    let err = parse_replay_config(&raw).expect_err("dot-bearing component must be rejected");
    let msg = format!("{err:#}");
    assert!(
        msg.contains("must match `[A-Za-z0-9_-]+`"),
        "expected identifier-contract diagnostic, got: {msg}"
    );
    assert!(
        msg.contains("ambiguous qualified keys"),
        "expected collision-risk explanation, got: {msg}"
    );
}

#[test]
fn rejects_component_name_with_path_separator_to_prevent_output_dir_escape() {
    // `..` / `/` would escape the CLI's default
    // `riptide-output/replays/<names>-multi` subtree.
    let raw = multi_config_with_component_name("../../etc");
    let err = parse_replay_config(&raw).expect_err("path-bearing component must be rejected");
    assert!(format!("{err:#}").contains("must match `[A-Za-z0-9_-]+`"));

    let raw = multi_config_with_component_name("lst/lending");
    let err = parse_replay_config(&raw).expect_err("slash-bearing component must be rejected");
    assert!(format!("{err:#}").contains("must match `[A-Za-z0-9_-]+`"));
}

#[test]
fn rejects_component_name_with_control_characters_to_prevent_ansi_injection() {
    // Newlines, CRs, and ANSI escape prefixes are rejected at parse
    // time so operator-visible CLI + pack output stays uncorrupted.
    let raw = multi_config_with_component_name("foo\nbar");
    let err = parse_replay_config(&raw).expect_err("newline must be rejected");
    assert!(format!("{err:#}").contains("must match `[A-Za-z0-9_-]+`"));

    let raw = multi_config_with_component_name("foo\u{001b}[31m");
    let err = parse_replay_config(&raw).expect_err("ANSI escape prefix must be rejected");
    assert!(format!("{err:#}").contains("must match `[A-Za-z0-9_-]+`"));

    let raw = multi_config_with_component_name("foo bar");
    let err = parse_replay_config(&raw).expect_err("whitespace must be rejected");
    assert!(format!("{err:#}").contains("must match `[A-Za-z0-9_-]+`"));
}

#[test]
fn rejects_bridge_name_with_control_characters() {
    let raw = r#"{
        "components": [
            { "name": "a", "adapter": "/tmp/a/adapter.toml", "trajectory_dir": "/tmp/a" },
            { "name": "b", "adapter": "/tmp/b/adapter.toml", "trajectory_dir": "/tmp/b" }
        ],
        "bridges": [
            { "name": "bad\nbridge",
              "source_component": "a", "source_field": "pool.x",
              "target_component": "b", "target_oracle": "feed",
              "transform": { "kind": "bps-ratio",
                             "base_price": 1.0, "denominator": 10000.0 } }
        ],
        "output_path": "riptide-output/replays/x"
    }"#;
    let err = parse_replay_config(raw).expect_err("newline-bearing bridge name must be rejected");
    let msg = format!("{err:#}");
    assert!(msg.contains("bridges[0].name"));
    assert!(msg.contains("must match `[A-Za-z0-9_-]+`"));
}

#[test]
fn rejects_bridge_target_oracle_with_path_separator() {
    let raw = r#"{
        "components": [
            { "name": "a", "adapter": "/tmp/a/adapter.toml", "trajectory_dir": "/tmp/a" },
            { "name": "b", "adapter": "/tmp/b/adapter.toml", "trajectory_dir": "/tmp/b" }
        ],
        "bridges": [
            { "name": "bridge",
              "source_component": "a", "source_field": "pool.x",
              "target_component": "b", "target_oracle": "../feed",
              "transform": { "kind": "bps-ratio",
                             "base_price": 1.0, "denominator": 10000.0 } }
        ],
        "output_path": "riptide-output/replays/x"
    }"#;
    let err = parse_replay_config(raw).expect_err("path-separator target_oracle must be rejected");
    let msg = format!("{err:#}");
    assert!(msg.contains("bridges[0].target_oracle"));
    assert!(msg.contains("must match `[A-Za-z0-9_-]+`"));
}

#[test]
fn rejects_bridge_source_field_with_control_character() {
    let raw = r#"{
        "components": [
            { "name": "a", "adapter": "/tmp/a/adapter.toml", "trajectory_dir": "/tmp/a" },
            { "name": "b", "adapter": "/tmp/b/adapter.toml", "trajectory_dir": "/tmp/b" }
        ],
        "bridges": [
            { "name": "bridge",
              "source_component": "a", "source_field": "pool\nexchange_rate",
              "target_component": "b", "target_oracle": "feed",
              "transform": { "kind": "bps-ratio",
                             "base_price": 1.0, "denominator": 10000.0 } }
        ],
        "output_path": "riptide-output/replays/x"
    }"#;
    let err = parse_replay_config(raw).expect_err("control-char source_field must be rejected");
    let msg = format!("{err:#}");
    assert!(msg.contains("bridges[0].source_field"));
    assert!(msg.contains("must match `[A-Za-z0-9_.-]+`"));
}

#[test]
fn rejects_bridge_source_component_with_control_characters() {
    // The cross-reference lookup previously interpolated the raw
    // source_component into the "unknown source component `…`"
    // diagnostic via `{}`, letting a hostile config inject newlines
    // / ANSI escapes into the operator-visible parser output. The
    // contract now rejects control-char source_component names
    // before the lookup runs.
    let raw = r#"{
        "components": [
            { "name": "a", "adapter": "/tmp/a/adapter.toml", "trajectory_dir": "/tmp/a" },
            { "name": "b", "adapter": "/tmp/b/adapter.toml", "trajectory_dir": "/tmp/b" }
        ],
        "bridges": [
            { "name": "bridge",
              "source_component": "ghost\nline",
              "source_field": "pool.x",
              "target_component": "b", "target_oracle": "feed",
              "transform": { "kind": "bps-ratio",
                             "base_price": 1.0, "denominator": 10000.0 } }
        ],
        "output_path": "riptide-output/replays/x"
    }"#;
    let err = parse_replay_config(raw).expect_err("control-char source_component must be rejected");
    let msg = format!("{err:#}");
    assert!(
        msg.contains("bridges[0].source_component"),
        "diagnostic must name the exact JSON path, got: {msg}"
    );
    assert!(
        msg.contains("must match `[A-Za-z0-9_-]+`"),
        "diagnostic must cite the identifier contract, got: {msg}"
    );
    // Critical: the message must NOT contain a literal newline that
    // echoes the hostile bytes. `{:?}` escaping turns "\n" into the
    // two-character sequence `\n`.
    assert!(
        !msg.contains("ghost\nline"),
        "diagnostic must not echo raw control bytes verbatim; got: {msg}"
    );
    assert!(
        msg.contains(r#""ghost\nline""#) || msg.contains(r#"\nline"#),
        "diagnostic must echo the offending value with control bytes escaped; got: {msg}"
    );
}

#[test]
fn rejects_bridge_target_component_with_path_separator() {
    let raw = r#"{
        "components": [
            { "name": "a", "adapter": "/tmp/a/adapter.toml", "trajectory_dir": "/tmp/a" },
            { "name": "b", "adapter": "/tmp/b/adapter.toml", "trajectory_dir": "/tmp/b" }
        ],
        "bridges": [
            { "name": "bridge",
              "source_component": "a",
              "source_field": "pool.x",
              "target_component": "../escape",
              "target_oracle": "feed",
              "transform": { "kind": "bps-ratio",
                             "base_price": 1.0, "denominator": 10000.0 } }
        ],
        "output_path": "riptide-output/replays/x"
    }"#;
    let err =
        parse_replay_config(raw).expect_err("path-separator target_component must be rejected");
    let msg = format!("{err:#}");
    assert!(msg.contains("bridges[0].target_component"));
    assert!(msg.contains("must match `[A-Za-z0-9_-]+`"));
}

#[test]
fn unknown_source_component_diagnostic_escapes_control_bytes_defense_in_depth() {
    // Even if a future regression weakened the identifier pre-check,
    // the unknown-component branch now echoes names with `{:?}`
    // instead of raw `{}`. Pin that rendering against a bridge that
    // points at a well-formed but undeclared component so we can
    // observe the actual unknown-component diagnostic path (not the
    // identifier-contract path).
    let raw = r#"{
        "components": [
            { "name": "a", "adapter": "/tmp/a/adapter.toml", "trajectory_dir": "/tmp/a" },
            { "name": "b", "adapter": "/tmp/b/adapter.toml", "trajectory_dir": "/tmp/b" }
        ],
        "bridges": [
            { "name": "bridge",
              "source_component": "ghost_component",
              "source_field": "pool.x",
              "target_component": "b", "target_oracle": "feed",
              "transform": { "kind": "bps-ratio",
                             "base_price": 1.0, "denominator": 10000.0 } }
        ],
        "output_path": "riptide-output/replays/x"
    }"#;
    let err = parse_replay_config(raw).expect_err("unknown source_component must be rejected");
    let msg = format!("{err:#}");
    assert!(
        msg.contains(r#"references unknown source component "ghost_component""#),
        "unknown-component diagnostic must use `{{:?}}`-style escaping, got: {msg}"
    );
}

#[test]
fn accepts_bridge_source_field_with_dotted_path() {
    // Positive case: the canonical shipping bridge references
    // `pool.exchange_rate_bps` as a qualified field path. `.` is
    // legitimate here because the field is a reference into the
    // upstream snapshot, not a new identifier being introduced.
    let raw = r#"{
        "components": [
            { "name": "liquid_staking", "adapter": "/tmp/a/adapter.toml", "trajectory_dir": "/tmp/a" },
            { "name": "lending", "adapter": "/tmp/b/adapter.toml", "trajectory_dir": "/tmp/b" }
        ],
        "bridges": [
            { "name": "lst_exchange_rate_to_lending_oracle",
              "source_component": "liquid_staking",
              "source_field": "pool.exchange_rate_bps",
              "target_component": "lending",
              "target_oracle": "collateral_price_feed",
              "transform": { "kind": "bps-ratio",
                             "base_price": 100.0, "denominator": 10000.0 } }
        ],
        "output_path": "riptide-output/replays/x"
    }"#;
    parse_replay_config(raw).expect("dotted source_field + safe identifiers must parse");
}

#[test]
fn accepts_the_canonical_shipping_contagion_proof_config() {
    // Belt-and-braces: after the hardening, the Sprint 11 shipping
    // contagion proof config must continue to parse cleanly.
    let raw = std::fs::read_to_string(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("engine crate has a parent directory")
            .join("fixtures/replays/lst-lending-contagion-proof/config.json"),
    )
    .expect("read shipping contagion proof config");
    parse_replay_config(&raw)
        .expect("shipping contagion proof config must still parse under the new identifier rules");
}
