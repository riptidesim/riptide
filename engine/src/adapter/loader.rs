//! TOML loader with actionable error messages.
//!
//! Every error carries the adapter file path and, where possible, the
//! offending key — so a developer debugging an adapter sees "which file,
//! which key" on the first line, not a cryptic "unknown variant".

use std::{fmt, path::Path};

use crate::adapter::schema::{Adapter, Protocol, LENDING_ACTIONS, LENDING_OBSERVATIONS};

/// Errors returned by `load_adapter`. Every variant carries enough
/// context to point at the file and key that caused the failure.
#[derive(Debug)]
pub enum AdapterError {
    /// Filesystem I/O error (open, read).
    Io {
        path: String,
        source: std::io::Error,
    },
    /// TOML syntax / type-mismatch error from serde.
    Parse {
        path: String,
        source: toml::de::Error,
    },
    /// Schema validation failed — e.g. a `[state_mapping]` value refers
    /// to an unknown observation, or a `[instructions]` entry names an
    /// action the lending primitive doesn't support.
    Validation {
        path: String,
        key: String,
        reason: String,
    },
}

impl fmt::Display for AdapterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { path, source } => write!(f, "{path}: read failed: {source}"),
            Self::Parse { path, source } => write!(f, "{path}: TOML parse failed: {source}"),
            Self::Validation { path, key, reason } => {
                write!(f, "{path}: `{key}`: {reason}")
            }
        }
    }
}

impl std::error::Error for AdapterError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Parse { source, .. } => Some(source),
            Self::Validation { .. } => None,
        }
    }
}

/// Load and validate an adapter TOML file.
///
/// Validation rules (v0, lending protocol):
/// - `[instructions]` must not be empty.
/// - Every `[instructions]` entry's `action` must be one of the five
///   lending actions.
/// - `[state_mapping]` keys must match the `"<account>.<field>"` shape.
/// - `[state_mapping]` values must be one of the logical observation
///   names the lending tick loop consumes.
///
/// The `[actions]`, `[observations]`, `[personas]` blocks are accepted
/// but not validated when `protocol = "lending"` — they belong to the
/// generic primitive (T05).
pub fn load_adapter(path: &Path) -> Result<Adapter, AdapterError> {
    let path_str = path.display().to_string();
    let raw = std::fs::read_to_string(path).map_err(|source| AdapterError::Io {
        path: path_str.clone(),
        source,
    })?;
    let adapter: Adapter = toml::from_str(&raw).map_err(|source| AdapterError::Parse {
        path: path_str.clone(),
        source,
    })?;

    validate(&adapter, &path_str)?;
    Ok(adapter)
}

/// Parse adapter TOML from a string without touching the filesystem.
/// Used by unit tests; also useful for the `riptide adapt` generator
/// (T07) to validate generated output before writing.
pub fn parse_adapter_str(toml_str: &str, virtual_path: &str) -> Result<Adapter, AdapterError> {
    let adapter: Adapter = toml::from_str(toml_str).map_err(|source| AdapterError::Parse {
        path: virtual_path.to_string(),
        source,
    })?;
    validate(&adapter, virtual_path)?;
    Ok(adapter)
}

fn validate(adapter: &Adapter, path: &str) -> Result<(), AdapterError> {
    match adapter.protocol {
        Protocol::Lending => validate_lending(adapter, path),
        Protocol::Generic => validate_generic(adapter, path),
    }
}

fn validate_lending(adapter: &Adapter, path: &str) -> Result<(), AdapterError> {
    if adapter.instructions.is_empty() {
        return Err(AdapterError::Validation {
            path: path.to_string(),
            key: "[instructions]".into(),
            reason: "lending adapters must declare at least one instruction mapping".into(),
        });
    }

    // Every instruction's action must be a known lending action.
    for (ix_name, mapping) in &adapter.instructions {
        if !LENDING_ACTIONS.contains(&mapping.action.as_str()) {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: format!("[instructions].{ix_name}.action"),
                reason: format!(
                    "unknown lending action `{}`; expected one of {:?}",
                    mapping.action, LENDING_ACTIONS
                ),
            });
        }
    }

    // state_mapping keys must be `<account>.<field>` shape.
    // state_mapping values must be a known observation name.
    for (key, logical) in &adapter.state_mapping {
        let (account, field) = key.split_once('.').ok_or_else(|| AdapterError::Validation {
            path: path.to_string(),
            key: format!("[state_mapping].{key}"),
            reason: "state_mapping keys must be `<account>.<field>` (e.g. `pool.total_deposits`)"
                .into(),
        })?;
        if account.is_empty() || field.is_empty() {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: format!("[state_mapping].{key}"),
                reason: "state_mapping keys must be `<account>.<field>` (non-empty both sides)"
                    .into(),
            });
        }
        if !LENDING_OBSERVATIONS.contains(&logical.as_str()) {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: format!("[state_mapping].{key}"),
                reason: format!(
                    "unknown lending observation `{logical}`; expected one of {:?}",
                    LENDING_OBSERVATIONS
                ),
            });
        }
    }

    Ok(())
}

fn validate_generic(_adapter: &Adapter, _path: &str) -> Result<(), AdapterError> {
    // T05 owns generic-protocol validation. The loader only needs to
    // accept the file here so adapters targeting the generic primitive
    // can be parsed before the T05 code lands.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::schema::InstructionMapping;

    fn sample_lending_toml() -> &'static str {
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
"#
    }

    #[test]
    fn parses_lending_adapter() {
        let adapter = parse_adapter_str(sample_lending_toml(), "test.toml").unwrap();
        assert!(matches!(adapter.protocol, Protocol::Lending));
        assert_eq!(adapter.instructions.len(), 5);
        assert_eq!(
            adapter.instructions.get("deposit"),
            Some(&InstructionMapping {
                action: "deposit".to_string(),
                amount: Some("amount".to_string()),
            })
        );
        assert_eq!(adapter.state_mapping.len(), 6);
        assert_eq!(
            adapter.state_mapping.get("pool.total_deposits"),
            Some(&"tvl".to_string())
        );
    }

    #[test]
    fn rejects_unknown_lending_action() {
        let toml_str = r#"
protocol = "lending"

[instructions]
foo = { action = "bogus" }

[state_mapping]
"pool.total_deposits" = "tvl"
"#;
        let err = parse_adapter_str(toml_str, "test.toml").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("test.toml"), "missing path: {msg}");
        assert!(msg.contains("[instructions].foo.action"), "missing key: {msg}");
        assert!(msg.contains("bogus"), "missing offending value: {msg}");
    }

    #[test]
    fn rejects_malformed_state_mapping_key() {
        let toml_str = r#"
protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"poolwithoutdot" = "tvl"
"#;
        let err = parse_adapter_str(toml_str, "test.toml").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("[state_mapping].poolwithoutdot"), "got: {msg}");
        assert!(msg.contains("<account>.<field>"), "got: {msg}");
    }

    #[test]
    fn rejects_unknown_observation() {
        let toml_str = r#"
protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "magic_number"
"#;
        let err = parse_adapter_str(toml_str, "test.toml").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("[state_mapping].pool.total_deposits"), "got: {msg}");
        assert!(msg.contains("magic_number"), "got: {msg}");
    }

    #[test]
    fn rejects_empty_instructions() {
        let toml_str = r#"
protocol = "lending"

[instructions]

[state_mapping]
"pool.total_deposits" = "tvl"
"#;
        let err = parse_adapter_str(toml_str, "test.toml").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("[instructions]"), "got: {msg}");
        assert!(msg.contains("at least one"), "got: {msg}");
    }

    #[test]
    fn accepts_generic_protocol_without_lending_validation() {
        let toml_str = r#"
protocol = "generic"

[instructions]
craft = { action = "craft", amount = "amount" }

[state_mapping]
"resource.balance" = "inventory"
"#;
        // The generic protocol path doesn't enforce lending-action or
        // lending-observation names — T05 will own its own validation.
        let adapter = parse_adapter_str(toml_str, "generic.toml").unwrap();
        assert!(matches!(adapter.protocol, Protocol::Generic));
    }

    #[test]
    fn accepts_reserved_generic_blocks_on_lending_adapter() {
        let toml_str = r#"
protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"

[actions.future_action]
label = "future"

[observations.future_obs]
label = "future"

[personas.future_persona]
label = "future"
"#;
        let adapter = parse_adapter_str(toml_str, "test.toml").unwrap();
        assert_eq!(adapter.actions.len(), 1);
        assert_eq!(adapter.observations.len(), 1);
        assert_eq!(adapter.personas.len(), 1);
    }

    #[test]
    fn io_error_carries_path() {
        let err = load_adapter(std::path::Path::new("/nonexistent/adapter.toml")).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("/nonexistent/adapter.toml"), "got: {msg}");
    }

    #[test]
    fn parse_error_carries_path() {
        let toml_str = "protocol = \"lending\"\n[instructions\n";
        let err = parse_adapter_str(toml_str, "busted.toml").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("busted.toml"), "got: {msg}");
    }

    #[test]
    fn loads_shipped_solend_fork_fixture() {
        let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("fixtures")
            .join("adapters")
            .join("solend-fork.toml");
        let adapter = load_adapter(&fixture)
            .unwrap_or_else(|e| panic!("fixture adapter should load: {e}"));
        assert!(matches!(adapter.protocol, Protocol::Lending));
        // All five canonical lending actions must be mapped.
        for action in LENDING_ACTIONS {
            let has_action = adapter
                .instructions
                .values()
                .any(|mapping| mapping.action == *action);
            assert!(has_action, "fixture missing action: {action}");
        }
        // tvl observation must be present at minimum.
        assert!(
            adapter
                .state_mapping
                .values()
                .any(|v| v == "tvl"),
            "fixture missing tvl observation"
        );
    }
}
