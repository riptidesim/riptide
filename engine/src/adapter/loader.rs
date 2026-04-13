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
    /// action the primitive doesn't support.
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
pub fn load_adapter(path: &Path) -> Result<Adapter, AdapterError> {
    let path_str = path.display().to_string();
    let raw = std::fs::read_to_string(path).map_err(|source| AdapterError::Io {
        path: path_str.clone(),
        source,
    })?;
    let mut adapter: Adapter = toml::from_str(&raw).map_err(|source| AdapterError::Parse {
        path: path_str.clone(),
        source,
    })?;

    validate(&adapter, &path_str)?;
    resolve_generic_paths(&mut adapter, path);
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

fn resolve_generic_paths(adapter: &mut Adapter, adapter_path: &Path) {
    if !matches!(adapter.protocol, Protocol::Generic) {
        return;
    }

    let Some(parent) = adapter_path.parent() else {
        return;
    };

    if let Some(program_so) = adapter.program_so.as_mut() {
        *program_so = resolve_relative_to(parent, program_so);
    }
    if let Some(idl_path) = adapter.idl_path.as_mut() {
        *idl_path = resolve_relative_to(parent, idl_path);
    }
}

fn resolve_relative_to(base: &Path, raw: &str) -> String {
    let path = Path::new(raw);
    if path.is_absolute() {
        raw.to_string()
    } else {
        base.join(path).display().to_string()
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
        validate_dotted_path(path, key)?;
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

fn validate_generic(adapter: &Adapter, path: &str) -> Result<(), AdapterError> {
    require_non_empty_option(
        path,
        "program_so",
        adapter.program_so.as_deref(),
        "generic adapters must declare `program_so`",
    )?;
    require_non_empty_option(
        path,
        "idl_path",
        adapter.idl_path.as_deref(),
        "generic adapters must declare `idl_path`",
    )?;

    if adapter.accounts.is_empty() {
        return Err(AdapterError::Validation {
            path: path.to_string(),
            key: "[accounts]".into(),
            reason: "generic adapters must declare at least one account binding".into(),
        });
    }
    if adapter.instructions.is_empty() {
        return Err(AdapterError::Validation {
            path: path.to_string(),
            key: "[instructions]".into(),
            reason: "generic adapters must declare at least one instruction mapping".into(),
        });
    }
    if adapter.actions.is_empty() {
        return Err(AdapterError::Validation {
            path: path.to_string(),
            key: "[actions]".into(),
            reason: "generic adapters must declare at least one action".into(),
        });
    }
    if adapter.observations.is_empty() {
        return Err(AdapterError::Validation {
            path: path.to_string(),
            key: "[observations]".into(),
            reason: "generic adapters must declare at least one observation".into(),
        });
    }
    if adapter.personas.is_empty() {
        return Err(AdapterError::Validation {
            path: path.to_string(),
            key: "[personas]".into(),
            reason: "generic adapters must declare at least one persona".into(),
        });
    }

    for (account_name, account) in &adapter.accounts {
        if account.space == 0 {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: format!("[accounts].{account_name}.space"),
                reason: "account space must be greater than zero".into(),
            });
        }
    }

    for (ix_name, mapping) in &adapter.instructions {
        if !adapter.actions.contains_key(&mapping.action) {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: format!("[instructions].{ix_name}.action"),
                reason: format!(
                    "unknown generic action `{}`; expected one of {:?}",
                    mapping.action,
                    adapter.actions.keys().collect::<Vec<_>>()
                ),
            });
        }
    }

    for (action_name, action) in &adapter.actions {
        if action.takes.len() > 1 {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: format!("[actions].{action_name}.takes"),
                reason:
                    "T05 v0 supports either zero args or one numeric arg; expand only if T06 needs more"
                        .into(),
            });
        }
        if let Some(expected_arg) = action.takes.first() {
            let has_bound_arg = adapter.instructions.values().any(|mapping| {
                mapping.action == *action_name && mapping.amount.as_deref() == Some(expected_arg)
            });
            if !has_bound_arg {
                return Err(AdapterError::Validation {
                    path: path.to_string(),
                    key: format!("[actions].{action_name}.takes"),
                    reason: format!(
                        "action `{action_name}` expects arg `{expected_arg}` but no matching `[instructions].*.amount` binding was found"
                    ),
                });
            }
        }
    }

    for (key, logical) in &adapter.state_mapping {
        let (account, _) = validate_dotted_path(path, key)?;
        if !adapter.accounts.contains_key(account) {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: format!("[state_mapping].{key}"),
                reason: format!(
                    "unknown generic account binding `{account}`; declare it under `[accounts]`"
                ),
            });
        }
        if !adapter.observations.contains_key(logical) {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: format!("[state_mapping].{key}"),
                reason: format!(
                    "unknown generic observation `{logical}`; declare it under `[observations]`"
                ),
            });
        }
    }

    for (persona_name, persona) in &adapter.personas {
        if !persona.action_rate_multiplier.is_finite() || persona.action_rate_multiplier < 0.0 {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: format!("[personas].{persona_name}.action_rate_multiplier"),
                reason: "action_rate_multiplier must be a finite non-negative float".into(),
            });
        }

        for action_name in persona.action_weights.keys() {
            if !adapter.actions.contains_key(action_name) {
                return Err(AdapterError::Validation {
                    path: path.to_string(),
                    key: format!("[personas].{persona_name}.action_weights.{action_name}"),
                    reason: format!(
                        "unknown generic action `{action_name}`; expected one of {:?}",
                        adapter.actions.keys().collect::<Vec<_>>()
                    ),
                });
            }
        }

        for (idx, trigger) in persona.triggers.iter().enumerate() {
            if !adapter.actions.contains_key(&trigger.action) {
                return Err(AdapterError::Validation {
                    path: path.to_string(),
                    key: format!("[personas].{persona_name}.triggers[{idx}].then"),
                    reason: format!(
                        "unknown generic action `{}`; expected one of {:?}",
                        trigger.action,
                        adapter.actions.keys().collect::<Vec<_>>()
                    ),
                });
            }
            validate_trigger_condition(path, persona_name, idx, &trigger.condition)?;
            if !trigger.weight_boost.is_finite() {
                return Err(AdapterError::Validation {
                    path: path.to_string(),
                    key: format!("[personas].{persona_name}.triggers[{idx}].weight_boost"),
                    reason: "weight_boost must be a finite float".into(),
                });
            }
        }
    }

    Ok(())
}

fn require_non_empty_option(
    path: &str,
    key: &str,
    value: Option<&str>,
    reason: &str,
) -> Result<(), AdapterError> {
    if value.is_none_or(|value| value.trim().is_empty()) {
        return Err(AdapterError::Validation {
            path: path.to_string(),
            key: key.to_string(),
            reason: reason.to_string(),
        });
    }
    Ok(())
}

fn validate_dotted_path<'a>(path: &str, key: &'a str) -> Result<(&'a str, &'a str), AdapterError> {
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
            reason: "state_mapping keys must be `<account>.<field>` (non-empty both sides)".into(),
        });
    }
    Ok((account, field))
}

fn validate_trigger_condition(
    path: &str,
    persona_name: &str,
    idx: usize,
    condition: &str,
) -> Result<(), AdapterError> {
    // T05 v0: expand if T06 fixture needs more.
    let parts: Vec<_> = condition.split_whitespace().collect();
    if parts.len() != 3 {
        return Err(AdapterError::Validation {
            path: path.to_string(),
            key: format!("[personas].{persona_name}.triggers[{idx}].if"),
            reason:
                "generic trigger conditions must be `<observation> <op> <constant>` in T05 v0"
                    .into(),
        });
    }
    match parts[1] {
        "<" | ">" | "==" => {}
        other => {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: format!("[personas].{persona_name}.triggers[{idx}].if"),
                reason: format!("unsupported generic trigger operator `{other}`; expected one of [\"<\", \">\", \"==\"]"),
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::schema::{
        InstructionMapping, LENDING_ACTIONS, ObservationType, Protocol,
    };

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

    fn sample_generic_toml() -> &'static str {
        r#"
protocol = "generic"
program_so = "programs/resource_grinder/target/deploy/resource_grinder.so"
idl_path = "fixtures/idls/resource-grinder.json"

[accounts.player]
kind = "agent"
space = 32

[accounts.marketplace]
kind = "shared"
space = 512

[instructions]
mine = { action = "mine" }
craft = { action = "craft" }
list_for_sale = { action = "list_for_sale" }

[state_mapping]
"player.gold" = "player.gold"
"player.wood" = "player.wood"
"marketplace.listings" = "marketplace.listings"

[actions.mine]
takes = []

[actions.craft]
takes = []

[actions.list_for_sale]
takes = []

[observations]
"player.gold" = "uint"
"player.wood" = "uint"
"marketplace.listings" = "map"

[personas.grinder]
action_rate_multiplier = 1.0
action_weights = { mine = 1.0, craft = 0.2 }
triggers = [{ if = "player.wood < 10", then = "mine", weight_boost = 2.0 }]
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
    fn parses_generic_adapter() {
        let adapter = parse_adapter_str(sample_generic_toml(), "generic.toml").unwrap();
        assert!(matches!(adapter.protocol, Protocol::Generic));
        assert_eq!(adapter.accounts.len(), 2);
        assert_eq!(adapter.actions.len(), 3);
        assert_eq!(adapter.observations["player.gold"].kind(), ObservationType::UInt);
    }

    #[test]
    fn rejects_generic_missing_program_path() {
        let toml_str = sample_generic_toml().replace("program_so = \"programs/resource_grinder/target/deploy/resource_grinder.so\"\n", "");
        let err = parse_adapter_str(&toml_str, "generic.toml").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("program_so"), "got: {msg}");
    }

    #[test]
    fn rejects_unknown_generic_action_reference() {
        let toml_str = sample_generic_toml().replace("mine = { action = \"mine\" }", "mine = { action = \"bogus\" }");
        let err = parse_adapter_str(&toml_str, "generic.toml").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("[instructions].mine.action"), "got: {msg}");
        assert!(msg.contains("bogus"), "got: {msg}");
    }

    #[test]
    fn rejects_unknown_generic_trigger_operator() {
        let toml_str =
            sample_generic_toml().replace("player.wood < 10", "player.wood <= 10");
        let err = parse_adapter_str(&toml_str, "generic.toml").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("triggers[0].if"), "got: {msg}");
        assert!(msg.contains("unsupported"), "got: {msg}");
    }

    #[test]
    fn rejects_generic_unknown_account_binding_in_state_mapping() {
        let toml_str = sample_generic_toml().replace("\"player.gold\" = \"player.gold\"", "\"unknown.gold\" = \"player.gold\"");
        let err = parse_adapter_str(&toml_str, "generic.toml").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("[state_mapping].unknown.gold"), "got: {msg}");
        assert!(msg.contains("unknown generic account binding"), "got: {msg}");
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
        for action in LENDING_ACTIONS {
            let has_action = adapter
                .instructions
                .values()
                .any(|mapping| mapping.action == *action);
            assert!(has_action, "fixture missing action: {action}");
        }
        assert!(
            adapter.state_mapping.values().any(|v| v == "tvl"),
            "fixture missing tvl observation"
        );
    }
}
