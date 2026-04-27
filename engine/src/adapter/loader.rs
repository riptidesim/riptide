//! TOML loader with actionable error messages.
//!
//! Every error carries the adapter file path and, where possible, the
//! offending key — so a developer debugging an adapter sees "which file,
//! which key" on the first line, not a cryptic "unknown variant".

use std::{collections::BTreeSet, fmt, path::Path, str::FromStr};

use solana_sdk::pubkey::Pubkey;

use crate::adapter::schema::{
    is_valid_semantic_class, AccountKind, Adapter, Protocol, SemanticClassRef,
    SemanticSourceBinding, LENDING_ACTIONS, LENDING_OBSERVATIONS, LENDING_SNAPSHOT_METRICS,
    LENDING_V1_REQUIRED_ROLES, ORACLE_KINDS, SEMANTIC_CLASS_RE, SUPPORTED_SEMANTIC_CLASSES,
};
use crate::semantics::derived::{build_derived_order, DerivedObservationError};
use crate::semantics::expr::parse as parse_semantic_expr;

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
    MissingSemanticClass {
        path: String,
        key: String,
    },
    MalformedSemanticClass {
        path: String,
        key: String,
        value: String,
    },
    UnknownSemanticClass {
        path: String,
        key: String,
        name: String,
    },
    MalformedSemanticExpression {
        path: String,
        key: String,
        source: crate::semantics::error::ExprError,
    },
    DuplicateSemanticName {
        path: String,
        key: String,
        name: String,
    },
    UnknownSemanticSourceBinding {
        path: String,
        key: String,
        source: String,
    },
    MissingRequiredSemanticRole {
        path: String,
        key: String,
        role: String,
    },
    DerivedObservationCycle {
        path: String,
        key: String,
        cycle: Vec<String>,
    },
    UnknownSemanticIdentifier {
        path: String,
        key: String,
        name: String,
    },
}

impl fmt::Display for AdapterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { path, source } => {
                if source.kind() == std::io::ErrorKind::NotFound {
                    write!(
                        f,
                        "adapter TOML not found at {}\n\
                         Expected a path to an adapter file (e.g. fixtures/adapters/lending.toml).\n\
                         Check that --adapter points at a readable file, or drop the flag to use the default lending primitive.",
                        escape_diagnostic(path)
                    )
                } else {
                    write!(f, "{}: read failed: {source}", escape_diagnostic(path))
                }
            }
            Self::Parse { path, source } => write!(
                f,
                "{}: TOML parse failed: {source}\n\
                 Check for an unclosed bracket, a missing quote, or a stray comma near the \
                 reported line/column.",
                escape_diagnostic(path)
            ),
            Self::Validation { path, key, reason } => {
                write!(
                    f,
                    "{}: `{}`: {}",
                    escape_diagnostic(path),
                    escape_diagnostic(key),
                    escape_diagnostic(reason)
                )
            }
            Self::MissingSemanticClass { path, key } => write!(
                f,
                "{}: `{}`: MissingSemanticClass(class); `[semantics]` blocks must declare `class = \"lending.v1\"`",
                escape_diagnostic(path),
                escape_diagnostic(key)
            ),
            Self::MalformedSemanticClass { path, key, value } => write!(
                f,
                "{}: `{}`: malformed semantic class string `{}`; expected regex `{SEMANTIC_CLASS_RE}`",
                escape_diagnostic(path),
                escape_diagnostic(key),
                escape_diagnostic(value)
            ),
            Self::UnknownSemanticClass { path, key, name } => write!(
                f,
                "{}: `{}`: UnknownSemanticClass({}); supported semantic classes: {SUPPORTED_SEMANTIC_CLASSES:?}",
                escape_diagnostic(path),
                escape_diagnostic(key),
                escape_diagnostic(name)
            ),
            Self::MalformedSemanticExpression { path, key, source } => write!(
                f,
                "{}: `{}`: malformed semantic expression: {}",
                escape_diagnostic(path),
                escape_diagnostic(key),
                escape_diagnostic(&source.to_string())
            ),
            Self::DuplicateSemanticName { path, key, name } => write!(
                f,
                "{}: `{}`: duplicate semantic name `{}`",
                escape_diagnostic(path),
                escape_diagnostic(key),
                escape_diagnostic(name)
            ),
            Self::UnknownSemanticSourceBinding { path, key, source } => write!(
                f,
                "{}: `{}`: unknown source binding type `{}`; expected `instruction.<name>` or `account.<path>`",
                escape_diagnostic(path),
                escape_diagnostic(key),
                escape_diagnostic(source)
            ),
            Self::MissingRequiredSemanticRole { path, key, role } => write!(
                f,
                "{}: `{}`: missing required role `{}` for `lending.v1`",
                escape_diagnostic(path),
                escape_diagnostic(key),
                escape_diagnostic(role)
            ),
            Self::DerivedObservationCycle { path, key, cycle } => write!(
                f,
                "{}: `{}`: DerivedObservationCycle({cycle:?})",
                escape_diagnostic(path),
                escape_diagnostic(key)
            ),
            Self::UnknownSemanticIdentifier { path, key, name } => write!(
                f,
                "{}: `{}`: unknown semantic identifier `{}`",
                escape_diagnostic(path),
                escape_diagnostic(key),
                escape_diagnostic(name)
            ),
        }
    }
}

fn escape_diagnostic(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        if is_terminal_control(ch) {
            escaped.extend(ch.escape_debug());
        } else {
            escaped.push(ch);
        }
    }
    escaped
}

fn is_terminal_control(ch: char) -> bool {
    let code = ch as u32;
    code < 0x20 || code == 0x7f || (0x80..0xa0).contains(&code)
}

impl std::error::Error for AdapterError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Parse { source, .. } => Some(source),
            Self::MalformedSemanticExpression { source, .. } => Some(source),
            Self::Validation { .. } => None,
            Self::MissingSemanticClass { .. }
            | Self::MalformedSemanticClass { .. }
            | Self::UnknownSemanticClass { .. }
            | Self::DuplicateSemanticName { .. }
            | Self::UnknownSemanticSourceBinding { .. }
            | Self::MissingRequiredSemanticRole { .. }
            | Self::DerivedObservationCycle { .. }
            | Self::UnknownSemanticIdentifier { .. } => None,
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

    validate(&mut adapter, &path_str)?;
    resolve_generic_paths(&mut adapter, path);
    validate_resolved_paths(&adapter, &path_str)?;
    Ok(adapter)
}

/// Post-resolution existence check. Runs after `resolve_generic_paths`
/// so the message reports the absolute, adapter-relative path the engine
/// will actually try to load — not whatever shorthand the TOML author
/// typed. Only runs for generic adapters (the lending primitive has its
/// own `.so` discovery path in `harness::setup`).
fn validate_resolved_paths(adapter: &Adapter, path: &str) -> Result<(), AdapterError> {
    if !matches!(adapter.protocol, Protocol::Generic) {
        return Ok(());
    }
    if let Some(program_so) = adapter.program_so.as_deref() {
        if !std::path::Path::new(program_so).exists() {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: "program_so".into(),
                reason: format!(
                    "program .so not found at {program_so}\n\
                     Expected a compiled SBF artifact on disk.\n\
                     Run: cargo build-sbf --manifest-path <program>/Cargo.toml \
                     (or fix the `program_so` path in the adapter TOML) and retry."
                ),
            });
        }
    }
    for (account_name, account) in &adapter.accounts {
        let Some(owner) = account.owner.as_ref() else {
            continue;
        };
        let Some(owner_so) = owner.program_so.as_deref() else {
            continue;
        };
        let owner_path = std::path::Path::new(owner_so);
        if !owner_path.exists() {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: format!("[accounts].{account_name}.owner.program_so"),
                reason: format!(
                    "account `{account_name}`: owner program .so not found at {owner_so}\n\
                     Expected a compiled SBF artifact for the sibling program that owns this \
                     account on-chain.\n\
                     Run: cargo build-sbf --manifest-path <program>/Cargo.toml \
                     (or fix the `owner.program_so` path) and retry."
                ),
            });
        }
        let keypair_path =
            sibling_deploy_keypair_path(owner_path).ok_or_else(|| AdapterError::Validation {
                path: path.to_string(),
                key: format!("[accounts].{account_name}.owner.program_so"),
                reason: format!(
                    "account `{account_name}`: cannot derive sibling keypair path from \
                     `{owner_so}` (expected `<dir>/<program>.so` with a matching \
                     `<dir>/<program>-keypair.json`)."
                ),
            })?;
        if !keypair_path.exists() {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: format!("[accounts].{account_name}.owner.program_so"),
                reason: format!(
                    "account `{account_name}`: sibling-program keypair not found at {}.\n\
                     The generic harness derives the owner pubkey from the companion \
                     `*-keypair.json` that ships next to the `.so`. Build the sibling \
                     program with `cargo build-sbf` (which generates the keypair) or \
                     restore the keypair file before rerunning.",
                    keypair_path.display()
                ),
            });
        }
    }
    if let Some(idl_path) = adapter.idl_path.as_deref() {
        if !std::path::Path::new(idl_path).exists() {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: "idl_path".into(),
                reason: format!(
                    "IDL file not found at {idl_path}\n\
                     Expected a JSON IDL describing the program's instructions.\n\
                     Fix the `idl_path` entry in the adapter TOML to point at a readable file."
                ),
            });
        }
        // Cross-check declared `[accounts].*.space` against the fixed-
        // field minimum byte count computed from the IDL's account
        // declarations. acceptance criterion: "declared vs expected".
        // Variable-length fields (vec/option/defined) short-circuit the
        // check for an account; the minimum byte floor in
        // `validate_generic` still applies. If the IDL is unparseable
        // here we silently fall back — the dedicated parse-fail path
        // catches it at bootstrap time.
        if let Ok(raw) = std::fs::read_to_string(idl_path) {
            if let Ok(idl_json) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(idl_accounts) = idl_json.get("accounts").and_then(|v| v.as_array()) {
                    for idl_account in idl_accounts {
                        let Some(name) = idl_account.get("name").and_then(|v| v.as_str()) else {
                            continue;
                        };
                        let Some(declared) = adapter.accounts.get(name) else {
                            continue;
                        };
                        let Some(expected) = idl_fixed_min_size(idl_account) else {
                            // Variable-length (vec/option/defined)
                            // account — no tight minimum available.
                            continue;
                        };
                        if declared.space < expected {
                            return Err(AdapterError::Validation {
                                path: path.to_string(),
                                key: format!("[accounts].{name}.space"),
                                reason: format!(
                                    "account `{name}` declared as {declared_space} bytes but the \
                                     program expects at least {expected} bytes (fixed-field \
                                     minimum computed from `{idl_path}` account layout).\n\
                                     Fix `[accounts.{name}].space` in the adapter TOML to be >= {expected}, \
                                     or verify the account struct in the program source.",
                                    declared_space = declared.space,
                                ),
                            });
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

/// Derive the companion `<program>-keypair.json` path for a sibling
/// program's `.so` artifact. Shared by the loader (existence check) and
/// the generic harness (owner pubkey read), so both sides agree on the
/// single deploy-keypair convention the repo already follows.
pub(crate) fn sibling_deploy_keypair_path(
    program_so: &std::path::Path,
) -> Option<std::path::PathBuf> {
    let stem = program_so.file_stem()?.to_str()?;
    let parent = program_so.parent()?;
    Some(parent.join(format!("{stem}-keypair.json")))
}

/// Compute the minimum byte count needed to hold an IDL-declared
/// account's fixed-size fields. Returns `None` if any field's type
/// is variable-length (vec/option/defined) — in that case the loader
/// can't assert a tight minimum and falls back to the generic floor.
fn idl_fixed_min_size(idl_account: &serde_json::Value) -> Option<usize> {
    let fields = idl_account.get("fields").and_then(|v| v.as_array())?;
    let mut total: usize = 0;
    for field in fields {
        let ty = field.get("type")?;
        let size = primitive_type_size(ty)?;
        total = total.checked_add(size)?;
    }
    Some(total)
}

/// Primitive field size lookup. Returns `None` for any non-primitive
/// (vec/option/defined/array), forcing the caller to skip the account.
fn primitive_type_size(ty: &serde_json::Value) -> Option<usize> {
    if let Some(name) = ty.as_str() {
        return match name {
            "bool" | "u8" | "i8" => Some(1),
            "u16" | "i16" => Some(2),
            "u32" | "i32" | "f32" => Some(4),
            "u64" | "i64" | "f64" => Some(8),
            "u128" | "i128" => Some(16),
            "pubkey" | "publicKey" => Some(32),
            _ => None,
        };
    }
    None
}

/// Parse adapter TOML from a string without touching the filesystem.
/// Used by unit tests; also useful for the `riptide adapt` generator
/// to validate generated output before writing.
pub fn parse_adapter_str(toml_str: &str, virtual_path: &str) -> Result<Adapter, AdapterError> {
    let mut adapter: Adapter = toml::from_str(toml_str).map_err(|source| AdapterError::Parse {
        path: virtual_path.to_string(),
        source,
    })?;
    validate(&mut adapter, virtual_path)?;
    Ok(adapter)
}

fn validate(adapter: &mut Adapter, path: &str) -> Result<(), AdapterError> {
    // Reject identifiers that could inject control sequences into
    // operator-visible output. Adapter
    // TOML is loaded from untrusted sources (hand-authored by third
    // parties, generated by LLMs via `riptide adapt`, etc.), and a
    // key like "line\u001bbreak" would survive TOML parse unchanged
    // and flow through `snapshot_metrics` / `summarize_metrics` into
    // `renderSummary` as an ANSI-bearing string, letting a malicious
    // adapter forge CLI lines. The allow-list matches the names
    // already used by the shipped fixtures.
    validate_identifiers(adapter, path)?;
    validate_lineage(adapter, path)?;
    validate_semantics(adapter, path)?;
    match adapter.protocol {
        Protocol::Lending => validate_lending(adapter, path),
        Protocol::Generic => validate_generic(adapter, path),
    }
}

fn validate_semantics(adapter: &mut Adapter, path: &str) -> Result<(), AdapterError> {
    let Some(semantics) = adapter.semantics.as_mut() else {
        return Ok(());
    };

    let class = semantics
        .class
        .as_deref()
        .ok_or_else(|| AdapterError::MissingSemanticClass {
            path: path.to_string(),
            key: "[semantics].class".into(),
        })?;
    if !is_valid_semantic_class(class) {
        return Err(AdapterError::MalformedSemanticClass {
            path: path.to_string(),
            key: "[semantics].class".into(),
            value: class.to_string(),
        });
    }
    if class != "lending.v1" {
        return Err(AdapterError::UnknownSemanticClass {
            path: path.to_string(),
            key: "[semantics].class".into(),
            name: class.to_string(),
        });
    }
    if adapter.protocol != Protocol::Lending {
        let protocol = match adapter.protocol {
            Protocol::Lending => "lending",
            Protocol::Generic => "generic",
        };
        return Err(AdapterError::Validation {
            path: path.to_string(),
            key: "[semantics].class".into(),
            reason: format!(
                "`lending.v1` semantics require `protocol = \"lending\"`; protocol `{protocol}` has no semantics evaluator"
            ),
        });
    }
    semantics.class_ref = Some(SemanticClassRef::LendingV1);

    for role in LENDING_V1_REQUIRED_ROLES {
        if !semantics.roles.contains_key(*role) {
            return Err(AdapterError::MissingRequiredSemanticRole {
                path: path.to_string(),
                key: "[semantics.roles]".into(),
                role: (*role).to_string(),
            });
        }
    }

    for (role_name, role) in semantics.roles.iter_mut() {
        check_semantic_name(path, &format!("[semantics.roles].{role_name}"), role_name)?;
        let source_key = format!("[semantics.roles].{role_name}.source");
        role.binding = Some(parse_semantic_source(path, &source_key, &role.source)?);
        if role.fields.is_empty() {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: format!("[semantics.roles].{role_name}.fields"),
                reason: "semantic role must declare at least one typed field".into(),
            });
        }
        for field_name in role.fields.keys() {
            check_semantic_name(
                path,
                &format!("[semantics.roles].{role_name}.fields.{field_name}"),
                field_name,
            )?;
        }
    }

    for (name, expression) in semantics.derived.iter_mut() {
        check_semantic_name(path, &format!("[semantics.derived].{name}"), name)?;
        let ast = parse_semantic_expr(&expression.source).map_err(|source| {
            AdapterError::MalformedSemanticExpression {
                path: path.to_string(),
                key: format!("[semantics.derived].{name}"),
                source,
            }
        })?;
        expression.span = Some(ast.span);
        expression.ast = Some(ast);
    }

    semantics.derived_order =
        build_derived_order(&semantics.derived, &semantics.roles).map_err(|error| match error {
            DerivedObservationError::DerivedObservationCycle { path: cycle } => {
                AdapterError::DerivedObservationCycle {
                    path: path.to_string(),
                    key: "[semantics.derived]".into(),
                    cycle,
                }
            }
            DerivedObservationError::UnknownIdentifier { name } => {
                AdapterError::UnknownSemanticIdentifier {
                    path: path.to_string(),
                    key: "[semantics.derived]".into(),
                    name,
                }
            }
            DerivedObservationError::MissingParsedExpression { name } => AdapterError::Validation {
                path: path.to_string(),
                key: format!("[semantics.derived].{name}"),
                reason: "derived observation expression was not parsed before topo sort".into(),
            },
            DerivedObservationError::Evaluation { name, error } => AdapterError::Validation {
                path: path.to_string(),
                key: format!("[semantics.derived].{name}"),
                reason: format!("unexpected load-time evaluation error: {error}"),
            },
        })?;

    let mut invariant_names = BTreeSet::new();
    for (idx, invariant) in semantics.invariants.iter_mut().enumerate() {
        let name_key = format!("[[semantics.invariants]][{idx}].name");
        check_semantic_name(path, &name_key, &invariant.name)?;
        if !invariant_names.insert(invariant.name.as_str()) {
            return Err(AdapterError::DuplicateSemanticName {
                path: path.to_string(),
                key: name_key,
                name: invariant.name.clone(),
            });
        }
        if let Some(description) = invariant.description.as_deref() {
            check_label(
                path,
                &format!("[[semantics.invariants]][{idx}].description"),
                description,
            )?;
        }
        let ast = parse_semantic_expr(&invariant.expr.source).map_err(|source| {
            AdapterError::MalformedSemanticExpression {
                path: path.to_string(),
                key: format!("[[semantics.invariants]][{idx}].expr"),
                source,
            }
        })?;
        invariant.expr.span = Some(ast.span);
        invariant.expr.ast = Some(ast);
    }

    Ok(())
}

fn parse_semantic_source(
    path: &str,
    key: &str,
    source: &str,
) -> Result<SemanticSourceBinding, AdapterError> {
    if let Some(rest) = source.strip_prefix("instruction.") {
        if rest.is_empty() {
            return Err(AdapterError::UnknownSemanticSourceBinding {
                path: path.to_string(),
                key: key.to_string(),
                source: source.to_string(),
            });
        }
        check_ident(path, key, rest)?;
        return Ok(SemanticSourceBinding::Instruction(rest.to_string()));
    }
    if let Some(rest) = source.strip_prefix("account.") {
        if rest.is_empty() {
            return Err(AdapterError::UnknownSemanticSourceBinding {
                path: path.to_string(),
                key: key.to_string(),
                source: source.to_string(),
            });
        }
        for segment in rest.split('.') {
            check_ident(path, key, segment)?;
        }
        return Ok(SemanticSourceBinding::Account(rest.to_string()));
    }
    Err(AdapterError::UnknownSemanticSourceBinding {
        path: path.to_string(),
        key: key.to_string(),
        source: source.to_string(),
    })
}

fn check_semantic_name(path: &str, key: &str, value: &str) -> Result<(), AdapterError> {
    if is_safe_semantic_name(value) {
        Ok(())
    } else {
        Err(AdapterError::Validation {
            path: path.to_string(),
            key: key.to_string(),
            reason: format!(
                "semantic name `{}` must match `[a-z][a-z0-9_]*`",
                value.escape_debug()
            ),
        })
    }
}

fn is_safe_semantic_name(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_lowercase()
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// Validate the optional `[lineage]` block. Lineage is inspection-only
/// metadata — the loader does not validate `idl_source` against the
/// adapter's instruction / state mappings and does not fetch remote
/// IDLs. What it does check is the same anti-ANSI-injection guardrail
/// every other adapter-supplied string passes through: every list entry
/// and string field rejects control characters so adapter-supplied
/// lineage prose cannot smuggle escape sequences into
/// `riptide lineage`'s reviewer-facing output.
fn validate_lineage(adapter: &Adapter, path: &str) -> Result<(), AdapterError> {
    let Some(lineage) = adapter.lineage.as_ref() else {
        return Ok(());
    };
    if let Some(src) = lineage.idl_source.as_deref() {
        check_lineage_text(path, "[lineage].idl_source", src)?;
    }
    if let Some(gen) = lineage.generator.as_deref() {
        check_lineage_text(path, "[lineage].generator", gen)?;
    }
    for (idx, entry) in lineage.inferred_assumptions.iter().enumerate() {
        check_lineage_text(
            path,
            &format!("[lineage].inferred_assumptions[{idx}]"),
            entry,
        )?;
    }
    for (idx, entry) in lineage.unsupported_fields.iter().enumerate() {
        check_lineage_text(path, &format!("[lineage].unsupported_fields[{idx}]"), entry)?;
    }
    Ok(())
}

/// Allow-list character set for adapter-supplied identifiers that can
/// flow into serialized output. ASCII letters, digits, `_`, `-`, `.`
/// cover every shipped fixture (e.g. `player.gold`, `list_for_sale`,
/// `marketplace.listings`) and exclude every ANSI-injection vector.
const ADAPTER_IDENT_MAX_LEN: usize = 128;

fn is_safe_adapter_identifier(value: &str) -> bool {
    if value.is_empty() || value.len() > ADAPTER_IDENT_MAX_LEN {
        return false;
    }
    value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

fn reject_identifier(path: &str, key: &str, value: &str) -> AdapterError {
    AdapterError::Validation {
        path: path.to_string(),
        key: key.to_string(),
        reason: format!(
            "adapter identifier `{}` must match `[A-Za-z0-9_.-]+` (1..={ADAPTER_IDENT_MAX_LEN} chars); \
             control characters and whitespace are rejected so adapter-supplied names cannot inject \
             ANSI escape sequences into operator-visible CLI output",
            value.escape_debug()
        ),
    }
}

fn check_ident(path: &str, key: &str, value: &str) -> Result<(), AdapterError> {
    if is_safe_adapter_identifier(value) {
        Ok(())
    } else {
        Err(reject_identifier(path, key, value))
    }
}

/// Optional label fields (e.g. `[actions.<name>.label`) flow into the
/// same serialized output so they must also be free of control chars,
/// but they are human prose and may legitimately contain spaces and
/// punctuation. Reject C0/C1 controls and the DEL byte; allow the
/// rest of printable ASCII + UTF-8.
fn is_safe_adapter_label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= ADAPTER_IDENT_MAX_LEN * 2
        && !value.chars().any(|c| {
            (c as u32) < 0x20 || (c as u32) == 0x7f || ((c as u32) >= 0x80 && (c as u32) < 0xa0)
        })
}

fn check_label(path: &str, key: &str, value: &str) -> Result<(), AdapterError> {
    if is_safe_adapter_label(value) {
        Ok(())
    } else {
        Err(AdapterError::Validation {
            path: path.to_string(),
            key: key.to_string(),
            reason: format!(
                "adapter label must be non-empty and free of control characters \
                 (got `{}`) so adapter-supplied text cannot inject ANSI escape \
                 sequences into operator-visible CLI output",
                value.escape_debug()
            ),
        })
    }
}

/// Lineage prose is reviewer-facing documentation — inferred
/// assumptions and unsupported-field explanations. The label limit
/// (256 bytes) is too tight for honest multi-clause assumptions;
/// identifiers would be even tighter. Allow up to 1024 bytes so authors
/// can name a concrete IDL field AND explain why it is unsupported in
/// one entry, while still rejecting C0/C1 controls + DEL for ANSI-
/// injection defense.
const ADAPTER_LINEAGE_TEXT_MAX_LEN: usize = 1024;

fn is_safe_lineage_text(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= ADAPTER_LINEAGE_TEXT_MAX_LEN
        && !value.chars().any(|c| {
            (c as u32) < 0x20 || (c as u32) == 0x7f || ((c as u32) >= 0x80 && (c as u32) < 0xa0)
        })
}

fn check_lineage_text(path: &str, key: &str, value: &str) -> Result<(), AdapterError> {
    if is_safe_lineage_text(value) {
        Ok(())
    } else {
        Err(AdapterError::Validation {
            path: path.to_string(),
            key: key.to_string(),
            reason: format!(
                "lineage text must be non-empty, at most {ADAPTER_LINEAGE_TEXT_MAX_LEN} bytes, \
                 and free of C0/C1 control characters (got `{}`) so adapter-supplied text \
                 cannot inject ANSI escape sequences into operator-visible CLI output",
                value.escape_debug()
            ),
        })
    }
}

fn validate_identifiers(adapter: &Adapter, path: &str) -> Result<(), AdapterError> {
    for (account_name, _) in &adapter.accounts {
        check_ident(path, &format!("[accounts].{account_name}"), account_name)?;
    }
    for (ix_name, mapping) in &adapter.instructions {
        check_ident(path, &format!("[instructions].{ix_name}"), ix_name)?;
        check_ident(
            path,
            &format!("[instructions].{ix_name}.action"),
            &mapping.action,
        )?;
        if let Some(amount) = mapping.amount.as_deref() {
            check_ident(path, &format!("[instructions].{ix_name}.amount"), amount)?;
        }
        // literal-bound args (for multi-arg dispatch).
        // Each key is an IDL arg name the encoder later resolves
        // against the program's declared args; the value is a TOML
        // literal the encoder coerces into the matching Borsh type.
        // The key passes through `snapshot_metrics` / CLI output only
        // via debug paths, but we keep the same identifier allow-list
        // applied to every adapter-supplied name for consistency.
        for arg_name in mapping.args.keys() {
            check_ident(path, &format!("[instructions].{ix_name}.args"), arg_name)?;
        }
    }
    // state_mapping: keys are dotted paths — validate each segment —
    // and the logical-name values must themselves be safe identifiers,
    // since the generic state_mapping binds `"<account>.<field>" =>
    // "<logical_name>"` where the logical name can be a dotted path too
    // (e.g. `"player.gold"`).
    for (key, logical) in &adapter.state_mapping {
        let key_scope = format!("[state_mapping].{key}");
        for segment in key.split('.') {
            check_ident(path, &key_scope, segment)?;
        }
        for segment in logical.split('.') {
            check_ident(path, &format!("{key_scope} (value)"), segment)?;
        }
    }
    for (action_name, action) in &adapter.actions {
        check_ident(path, &format!("[actions].{action_name}"), action_name)?;
        if let Some(label) = action.label.as_deref() {
            check_label(path, &format!("[actions].{action_name}.label"), label)?;
        }
        for arg in &action.takes {
            check_ident(path, &format!("[actions].{action_name}.takes"), arg)?;
        }
    }
    for (obs_name, obs) in &adapter.observations {
        let scope = format!("[observations].{obs_name}");
        for segment in obs_name.split('.') {
            check_ident(path, &scope, segment)?;
        }
        if let crate::adapter::schema::ObservationDefinition::Detailed(shape) = obs {
            if let Some(label) = shape.label.as_deref() {
                check_label(path, &format!("{scope}.label"), label)?;
            }
        }
    }
    for (persona_name, persona) in &adapter.personas {
        check_ident(path, &format!("[personas].{persona_name}"), persona_name)?;
        if let Some(label) = persona.label.as_deref() {
            check_label(path, &format!("[personas].{persona_name}.label"), label)?;
        }
        for action_name in persona.action_weights.keys() {
            check_ident(
                path,
                &format!("[personas].{persona_name}.action_weights"),
                action_name,
            )?;
        }
    }
    Ok(())
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
    for account in adapter.accounts.values_mut() {
        let Some(owner) = account.owner.as_mut() else {
            continue;
        };
        if let Some(program_so) = owner.program_so.as_mut() {
            *program_so = resolve_relative_to(parent, program_so);
        }
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

    validate_invariants_lending(adapter, path)?;
    validate_oracles(adapter, path)?;
    validate_scheduled_actions(adapter, path)?;

    Ok(())
}

/// Validate `[[invariants]]` entries against the lending snapshot shape.
/// Accepts field names from either `LENDING_SNAPSHOT_METRICS` (engine-
/// emitted metric keys) or the adapter's declared logical observations
/// (state_mapping values — i.e. `LENDING_OBSERVATIONS`). Also checks the
/// optional `name` is a safe identifier and the value is finite.
fn validate_invariants_lending(adapter: &Adapter, path: &str) -> Result<(), AdapterError> {
    let declared_logical: std::collections::BTreeSet<&str> =
        adapter.state_mapping.values().map(|v| v.as_str()).collect();
    for (idx, inv) in adapter.invariants.iter().enumerate() {
        let key = format!("[[invariants]][{idx}].field");
        if inv.field.is_empty() {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key,
                reason: "invariant `field` must be non-empty".into(),
            });
        }
        check_ident(path, &key, &inv.field)?;
        let ok = LENDING_SNAPSHOT_METRICS.contains(&inv.field.as_str())
            || LENDING_OBSERVATIONS.contains(&inv.field.as_str())
            || declared_logical.contains(inv.field.as_str());
        if !ok {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key,
                reason: format!(
                    "unknown invariant field `{}`; expected a snapshot metric ({:?}) \
                     or a lending observation ({:?})",
                    inv.field, LENDING_SNAPSHOT_METRICS, LENDING_OBSERVATIONS
                ),
            });
        }
        if let Some(name) = inv.name.as_deref() {
            check_ident(path, &format!("[[invariants]][{idx}].name"), name)?;
        }
        if !inv.value.is_finite() {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: format!("[[invariants]][{idx}].value"),
                reason: "invariant `value` must be a finite numeric literal".into(),
            });
        }
    }
    Ok(())
}

/// Validate `[[invariants]]` entries against a generic adapter's declared
/// observations. Generic invariant fields must name an entry in the
/// `[observations]` block (the same keys the generic primitive emits
/// to every tick snapshot).
fn validate_invariants_generic(adapter: &Adapter, path: &str) -> Result<(), AdapterError> {
    for (idx, inv) in adapter.invariants.iter().enumerate() {
        let key = format!("[[invariants]][{idx}].field");
        if inv.field.is_empty() {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key,
                reason: "invariant `field` must be non-empty".into(),
            });
        }
        check_ident(path, &key, &inv.field)?;
        if !adapter.observations.contains_key(&inv.field) {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key,
                reason: format!(
                    "unknown invariant field `{}`; declare it under `[observations]`",
                    inv.field
                ),
            });
        }
        if let Some(name) = inv.name.as_deref() {
            check_ident(path, &format!("[[invariants]][{idx}].name"), name)?;
        }
        if !inv.value.is_finite() {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: format!("[[invariants]][{idx}].value"),
                reason: "invariant `value` must be a finite numeric literal".into(),
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
        // Solana accounts at minimum carry an 8-byte Anchor/Borsh
        // discriminator; anything smaller cannot hold a usable program
        // state and almost always means the adapter author typed the
        // wrong number (e.g. `8` confused with `0`, or bits vs bytes).
        const MIN_ACCOUNT_SPACE: usize = 8;
        if account.space == 0 {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: format!("[accounts].{account_name}.space"),
                reason: format!(
                    "account `{account_name}` declared `space = 0` but Solana accounts must reserve \
                     at least {MIN_ACCOUNT_SPACE} bytes for the program discriminator.\n\
                     Set `[accounts.{account_name}].space` to the on-chain struct size the program \
                     expects (check the program source or IDL)."
                ),
            });
        }
        if account.space < MIN_ACCOUNT_SPACE {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: format!("[accounts].{account_name}.space"),
                reason: format!(
                    "account `{account_name}` declared `space = {}` but Solana accounts must reserve \
                     at least {MIN_ACCOUNT_SPACE} bytes for the program discriminator.\n\
                     Set `[accounts.{account_name}].space` to the on-chain struct size the program \
                     expects (check the program source or IDL).",
                    account.space
                ),
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
        // multi-arg actions are allowed. Each arg listed
        // in `takes` must be bound either through `[instructions].*.amount`
        // (the single runtime-bound arg) or through
        // `[instructions].*.args.<name>` (a literal or `@persona.<field>`
        // ref). Zero-arg actions stay legal (empty `takes`).
        //
        // **Per-mapping binding check (Round 4 tighten).** The runtime
        // resolves `action → instruction` by picking the first
        // `[instructions]` entry whose `action` matches — so split
        // bindings across multiple duplicate mappings (e.g. one
        // mapping binds `amount_in`, another binds `min_out`) would
        // silently pass load-time validation under the old
        // "union across mappings" logic and then fail mid-dispatch
        // when the first-picked mapping's bindings are incomplete.
        // Round 4 enforces: exactly ONE `[instructions]` entry per
        // action, and that entry must fully bind every arg the action
        // declares in `takes`.
        //
        // At most ONE arg may be bound to the runtime amount per
        // instruction — the tick loop passes a single `u64` amount
        // per decision and splitting it across multiple IDL args
        // would be ambiguous.
        let mappings_for_action: Vec<(&String, &crate::adapter::InstructionMapping)> = adapter
            .instructions
            .iter()
            .filter(|(_, mapping)| mapping.action == *action_name)
            .collect();
        if mappings_for_action.len() > 1 {
            let names: Vec<&str> = mappings_for_action
                .iter()
                .map(|(name, _)| name.as_str())
                .collect();
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: format!("[actions].{action_name}"),
                reason: format!(
                    "action `{action_name}` is targeted by multiple `[instructions]` entries ({names:?}); \
                     only one mapping per action is allowed because the runtime resolves by first match \
                     and any later mappings become dead code. If two on-chain instructions genuinely \
                     implement the same behavior, expose them as two separate adapter actions."
                ),
            });
        }
        let mapping = mappings_for_action.first().map(|(_, m)| *m);
        let bound_via_amount: std::collections::BTreeSet<&str> = mapping
            .and_then(|m| m.amount.as_deref())
            .into_iter()
            .collect();
        let bound_via_literals: std::collections::BTreeSet<&str> = mapping
            .map(|m| m.args.keys().map(String::as_str).collect())
            .unwrap_or_default();
        for expected_arg in &action.takes {
            let in_amount = bound_via_amount.contains(expected_arg.as_str());
            let in_literals = bound_via_literals.contains(expected_arg.as_str());
            if !in_amount && !in_literals {
                return Err(AdapterError::Validation {
                    path: path.to_string(),
                    key: format!("[actions].{action_name}.takes"),
                    reason: format!(
                        "action `{action_name}` declares arg `{expected_arg}` but no matching \
                         `[instructions].*.amount` or `[instructions].*.args.{expected_arg}` \
                         binding was found.\nEither bind the arg to the runtime amount via \
                         `amount = \"{expected_arg}\"` on the mapping instruction, or declare \
                         a literal constant under `args` on the mapping."
                    ),
                });
            }
            if in_amount && in_literals {
                return Err(AdapterError::Validation {
                    path: path.to_string(),
                    key: format!("[actions].{action_name}.takes"),
                    reason: format!(
                        "action `{action_name}` arg `{expected_arg}` is bound both as the \
                         runtime amount AND as a literal constant in `args` — pick one. \
                         Runtime amount → tick-loop decision drives the value; literal → \
                         adapter-declared constant."
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
            validate_trigger_condition(
                path,
                persona_name,
                idx,
                &trigger.condition,
                &adapter.observations,
            )?;
            if !trigger.weight_boost.is_finite() {
                return Err(AdapterError::Validation {
                    path: path.to_string(),
                    key: format!("[personas].{persona_name}.triggers[{idx}].weight_boost"),
                    reason: "weight_boost must be a finite float".into(),
                });
            }
        }
    }

    validate_account_owners(adapter, path)?;
    validate_invariants_generic(adapter, path)?;
    validate_oracles(adapter, path)?;
    validate_scheduled_actions(adapter, path)?;

    Ok(())
}

/// Validate the optional external-owner metadata on generic accounts.
///
/// - `kind = "agent"` accounts cannot opt into external ownership.
/// - Exactly one of `owner.program_so` / `owner.pubkey` must be set;
///   declaring both is ambiguous, declaring neither is an empty block.
/// - Literal pubkeys must be base58-decodable to a 32-byte key.
///
/// Every diagnostic names the offending `[accounts].<name>.owner.*`
/// TOML key so an author can jump straight to the line at fault.
fn validate_account_owners(adapter: &Adapter, path: &str) -> Result<(), AdapterError> {
    for (account_name, account) in &adapter.accounts {
        let Some(owner) = account.owner.as_ref() else {
            continue;
        };
        if matches!(account.kind, AccountKind::Agent) {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: format!("[accounts].{account_name}.owner"),
                reason: format!(
                    "account `{account_name}` declares external `owner` but `kind = \"agent\"`. \
                     External ownership is only valid for `kind = \"shared\"` accounts; \
                     agent-scoped accounts stay program-owned. Either remove the `owner` block \
                     or change the account's `kind` to `shared`."
                ),
            });
        }
        match (owner.program_so.as_deref(), owner.pubkey.as_deref()) {
            (Some(_), Some(_)) => {
                return Err(AdapterError::Validation {
                    path: path.to_string(),
                    key: format!("[accounts].{account_name}.owner"),
                    reason: format!(
                        "account `{account_name}` declares both `owner.program_so` and \
                         `owner.pubkey`; exactly one owner source is accepted. Pick the local \
                         sibling-program path OR the literal base58 pubkey and remove the other."
                    ),
                });
            }
            (None, None) => {
                return Err(AdapterError::Validation {
                    path: path.to_string(),
                    key: format!("[accounts].{account_name}.owner"),
                    reason: format!(
                        "account `{account_name}` declares an empty `owner` block. Set either \
                         `owner.program_so = \"<path to .so>\"` for a local sibling program, \
                         or `owner.pubkey = \"<base58>\"` for a literal external program \
                         (e.g. Pyth)."
                    ),
                });
            }
            (Some(program_so), None) => {
                if program_so.trim().is_empty() {
                    return Err(AdapterError::Validation {
                        path: path.to_string(),
                        key: format!("[accounts].{account_name}.owner.program_so"),
                        reason: format!(
                            "account `{account_name}`: `owner.program_so` must be a non-empty path \
                             to the sibling program's compiled `.so` artifact."
                        ),
                    });
                }
            }
            (None, Some(pubkey)) => {
                if pubkey.trim().is_empty() {
                    return Err(AdapterError::Validation {
                        path: path.to_string(),
                        key: format!("[accounts].{account_name}.owner.pubkey"),
                        reason: format!(
                            "account `{account_name}`: `owner.pubkey` must be a non-empty \
                             base58-encoded 32-byte pubkey."
                        ),
                    });
                }
                Pubkey::from_str(pubkey).map_err(|error| AdapterError::Validation {
                    path: path.to_string(),
                    key: format!("[accounts].{account_name}.owner.pubkey"),
                    reason: format!(
                        "account `{account_name}`: `owner.pubkey` `{pubkey}` is not a valid \
                         base58-encoded 32-byte pubkey: {error}"
                    ),
                })?;
            }
        }
    }
    Ok(())
}

/// Validate the `[[oracles]]` block shared between lending and generic
/// adapters. Checks:
/// 1. `name` is a safe identifier.
/// 2. `base_price` is finite.
/// 3. Optional `account` reference (generic adapters) resolves to a
/// declared account.
/// 4. Oracle `name`s are unique within the adapter.
fn validate_oracles(adapter: &Adapter, path: &str) -> Result<(), AdapterError> {
    use crate::adapter::schema::OracleKind;
    use std::collections::BTreeSet;
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for (idx, oracle) in adapter.oracles.iter().enumerate() {
        if matches!(oracle.kind, OracleKind::Pyth) {
            // ships a real Pyth `PriceAccount` byte
            // layout for the aggregate-price read path (magic, ver,
            // atype=Price, expo, agg.{price,conf,status,pub_slot},
            // ema_price.val). A program built against
            // `pyth-sdk-solana` and limited to
            // `load_price_feed_from_account_info`'s aggregate path
            // will boot unchanged. SMA window, multi-publisher
            // aggregation, and the full per-publisher component
            // array are still out of scope (the comp[] slots stay
            // zero-filled in ). Adapters that depend on those
            // extended fields should track the + follow-up.
            eprintln!(
                "info: {path}: `[[oracles]][{idx}]` declares `kind = \"pyth\"` — \
                 aggregate-price read path ships. Programs that read \
                 `agg.price` / `agg.conf` / `expo` / `agg.pub_slot` via \
                 `pyth-sdk-solana` boot unchanged. Extended fields (SMA, \
                 multi-publisher aggregation) stay zero-filled."
            );
        }
        let key_name = format!("[[oracles]][{idx}].name");
        if oracle.name.is_empty() {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: key_name,
                reason: "oracle `name` must be non-empty".into(),
            });
        }
        check_ident(path, &key_name, &oracle.name)?;
        if !seen.insert(oracle.name.as_str()) {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: key_name,
                reason: format!(
                    "duplicate oracle `name` `{}`; every `[[oracles]]` entry \
                     must declare a unique name",
                    oracle.name
                ),
            });
        }
        if !oracle.base_price.is_finite() {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: format!("[[oracles]][{idx}].base_price"),
                reason: format!(
                    "oracle `{}`: `base_price` must be a finite numeric literal",
                    oracle.name
                ),
            });
        }
        if matches!(adapter.protocol, Protocol::Generic) {
            let Some(account) = oracle.account.as_deref() else {
                return Err(AdapterError::Validation {
                    path: path.to_string(),
                    key: format!("[[oracles]][{idx}].account"),
                    reason: format!(
                        "oracle `{}`: generic adapters must bind `[[oracles]].account` to a \
                         declared shared account. Add `account = \"<name>\"` and declare that \
                         account under `[accounts]` with `kind = \"shared\"`.",
                        oracle.name
                    ),
                });
            };
            let Some(declared_account) = adapter.accounts.get(account) else {
                let mut declared: Vec<&str> = adapter.accounts.keys().map(String::as_str).collect();
                declared.sort_unstable();
                return Err(AdapterError::Validation {
                    path: path.to_string(),
                    key: format!("[[oracles]][{idx}].account"),
                    reason: format!(
                        "oracle `{}`: `account` references unknown account `{}`; \
                         declare it under `[accounts]`. Declared: {:?}. \
                         Supported oracle kinds: {:?}.",
                        oracle.name, account, declared, ORACLE_KINDS
                    ),
                });
            };
            if !matches!(declared_account.kind, AccountKind::Shared) {
                return Err(AdapterError::Validation {
                    path: path.to_string(),
                    key: format!("[[oracles]][{idx}].account"),
                    reason: format!(
                        "oracle `{}`: bound account `{}` is declared with \
                         `kind = \"agent\"`, but oracle-bound accounts must be \
                         `kind = \"shared\"` (one oracle account per simulation).",
                        oracle.name, account
                    ),
                });
            }
        }
    }
    Ok(())
}

/// Validate the `[[scheduled_actions]]` block shared between lending
/// and generic adapters.
fn validate_scheduled_actions(adapter: &Adapter, path: &str) -> Result<(), AdapterError> {
    for (idx, sa) in adapter.scheduled_actions.iter().enumerate() {
        let key_instr = format!("[[scheduled_actions]][{idx}].instruction");
        if sa.instruction.is_empty() {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: key_instr,
                reason: "scheduled action `instruction` must be non-empty".into(),
            });
        }
        check_ident(path, &key_instr, &sa.instruction)?;
        if !adapter.instructions.contains_key(&sa.instruction) {
            let mut declared: Vec<&str> = adapter.instructions.keys().map(String::as_str).collect();
            declared.sort_unstable();
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: key_instr,
                reason: format!(
                    "unknown instruction `{}`; scheduled actions must reference a key \
                     of `[instructions]`. Declared: {:?}. \
                     Fix `[[scheduled_actions]][{idx}].instruction` or add the instruction \
                     to `[instructions]`.",
                    sa.instruction, declared
                ),
            });
        }
        if sa.interval_ticks == 0 {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: format!("[[scheduled_actions]][{idx}].interval_ticks"),
                reason: format!(
                    "scheduled action `{}`: `interval_ticks` must be a positive integer \
                     (the engine fires on every tick where `tick %% interval_ticks == 0`)",
                    sa.display_name(idx),
                ),
            });
        }
        if let Some(name) = sa.name.as_deref() {
            check_ident(path, &format!("[[scheduled_actions]][{idx}].name"), name)?;
        }
        for (acc_idx, account) in sa.accounts.iter().enumerate() {
            let key = format!("[[scheduled_actions]][{idx}].accounts[{acc_idx}]");
            check_ident(path, &key, account)?;
            if matches!(adapter.protocol, Protocol::Generic)
                && !adapter.accounts.contains_key(account)
            {
                let mut declared: Vec<&str> = adapter.accounts.keys().map(String::as_str).collect();
                declared.sort_unstable();
                return Err(AdapterError::Validation {
                    path: path.to_string(),
                    key,
                    reason: format!(
                        "scheduled action `{}`: account reference `{}` is not declared under \
                         `[accounts]`. Declared: {:?}.",
                        sa.display_name(idx),
                        account,
                        declared
                    ),
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
    let (account, field) = key
        .split_once('.')
        .ok_or_else(|| AdapterError::Validation {
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
    observations: &std::collections::BTreeMap<
        String,
        crate::adapter::schema::ObservationDefinition,
    >,
) -> Result<(), AdapterError> {
    let parts: Vec<_> = condition.split_whitespace().collect();
    if parts.len() != 3 {
        return Err(AdapterError::Validation {
            path: path.to_string(),
            key: format!("[personas].{persona_name}.triggers[{idx}].if"),
            reason: "generic trigger conditions must be `<observation> <op> <constant>` \
                 (e.g. `player.wood < 10`)"
                .into(),
        });
    }
    match parts[1] {
        "<" | ">" | "==" => {}
        other => {
            return Err(AdapterError::Validation {
                path: path.to_string(),
                key: format!("[personas].{persona_name}.triggers[{idx}].if"),
                reason: format!(
                    "unsupported generic trigger operator `{other}`; expected one of [\"<\", \">\", \"==\"]"
                ),
            });
        }
    }
    // Observation must be declared under `[observations]` — otherwise
    // the tick-time lookup will always miss and the trigger is dead
    // code. Fail loudly at load time with the declared set in hand.
    if !observations.contains_key(parts[0]) {
        let mut known: Vec<&str> = observations.keys().map(String::as_str).collect();
        known.sort_unstable();
        return Err(AdapterError::Validation {
            path: path.to_string(),
            key: format!("[personas].{persona_name}.triggers[{idx}].if"),
            reason: format!(
                "unknown observation `{}` in trigger condition; \
                 declare it under `[observations]` first. \
                 Declared observations: {:?}",
                parts[0], known
            ),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapter::schema::{InstructionMapping, ObservationType, Protocol, LENDING_ACTIONS};

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
                args: std::collections::BTreeMap::new(),
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
        assert!(
            msg.contains("[instructions].foo.action"),
            "missing key: {msg}"
        );
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
        assert!(
            msg.contains("[state_mapping].pool.total_deposits"),
            "got: {msg}"
        );
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
        assert_eq!(
            adapter.observations["player.gold"].kind(),
            ObservationType::UInt
        );
    }

    #[test]
    fn rejects_generic_missing_program_path() {
        let toml_str = sample_generic_toml().replace(
            "program_so = \"programs/resource_grinder/target/deploy/resource_grinder.so\"\n",
            "",
        );
        let err = parse_adapter_str(&toml_str, "generic.toml").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("program_so"), "got: {msg}");
    }

    #[test]
    fn rejects_unknown_generic_action_reference() {
        let toml_str = sample_generic_toml().replace(
            "mine = { action = \"mine\" }",
            "mine = { action = \"bogus\" }",
        );
        let err = parse_adapter_str(&toml_str, "generic.toml").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("[instructions].mine.action"), "got: {msg}");
        assert!(msg.contains("bogus"), "got: {msg}");
    }

    #[test]
    fn rejects_unknown_generic_trigger_operator() {
        let toml_str = sample_generic_toml().replace("player.wood < 10", "player.wood <= 10");
        let err = parse_adapter_str(&toml_str, "generic.toml").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("triggers[0].if"), "got: {msg}");
        assert!(msg.contains("unsupported"), "got: {msg}");
    }

    #[test]
    fn rejects_generic_unknown_account_binding_in_state_mapping() {
        let toml_str = sample_generic_toml().replace(
            "\"player.gold\" = \"player.gold\"",
            "\"unknown.gold\" = \"player.gold\"",
        );
        let err = parse_adapter_str(&toml_str, "generic.toml").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("[state_mapping].unknown.gold"), "got: {msg}");
        assert!(
            msg.contains("unknown generic account binding"),
            "got: {msg}"
        );
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

    // Untrusted adapter identifiers must not be able to smuggle
    // control characters into the
    // serialized metric map the CLI renders. These tests drive the
    // allow-list on every injection vector the generic primitive
    // exposes.

    #[test]
    fn rejects_observation_name_with_ansi_escape() {
        let toml_str = sample_generic_toml().replace(
            "\"marketplace.listings\" = \"map\"",
            "\"marketplace.\\u001bbreak\" = \"map\"",
        );
        let err = parse_adapter_str(&toml_str, "evil.toml").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("evil.toml"), "missing path: {msg}");
        assert!(msg.contains("[observations]"), "missing key: {msg}");
        assert!(
            msg.contains("adapter identifier") && msg.contains("ANSI"),
            "missing allow-list diagnostic: {msg}"
        );
    }

    #[test]
    fn rejects_action_name_with_embedded_newline() {
        let toml_str =
            sample_generic_toml().replace("[actions.mine]", "[actions.\"mine\\nforged\"]");
        let err = parse_adapter_str(&toml_str, "evil.toml").unwrap_err();
        assert!(
            err.to_string().contains("adapter identifier"),
            "expected identifier rejection, got: {err}"
        );
    }

    #[test]
    fn rejects_state_mapping_value_with_control_character() {
        let toml_str = sample_generic_toml().replace(
            "\"player.gold\" = \"player.gold\"",
            "\"player.gold\" = \"player.\\u0007bell\"",
        );
        let err = parse_adapter_str(&toml_str, "evil.toml").unwrap_err();
        assert!(
            err.to_string().contains("[state_mapping].player.gold"),
            "missing key scope: {err}"
        );
    }

    #[test]
    fn rejects_persona_label_with_escape_sequence() {
        let toml_str = sample_generic_toml().replace(
            "[personas.grinder]",
            "[personas.grinder]\nlabel = \"Grinder\\u001b[31mRED\"",
        );
        let err = parse_adapter_str(&toml_str, "evil.toml").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("[personas].grinder.label"), "got: {msg}");
        assert!(msg.contains("control characters"), "got: {msg}");
    }

    #[test]
    fn accepts_all_shipped_identifiers() {
        // Sanity: the shipped resource-grinder adapter must still pass
        // identifier validation.
        let adapter = parse_adapter_str(sample_generic_toml(), "generic.toml").unwrap();
        assert!(matches!(adapter.protocol, Protocol::Generic));
    }

    #[test]
    fn rejects_overlong_identifier() {
        let long = "a".repeat(ADAPTER_IDENT_MAX_LEN + 1);
        let toml_str =
            sample_generic_toml().replace("[actions.mine]", &format!("[actions.{long}]"));
        let err = parse_adapter_str(&toml_str, "long.toml").unwrap_err();
        assert!(err.to_string().contains("adapter identifier"), "got: {err}");
    }

    #[test]
    fn parses_shared_account_owner_pubkey() {
        let toml_str = r#"
protocol = "generic"
program_so = "programs/resource_grinder/target/deploy/resource_grinder.so"
idl_path = "fixtures/idls/resource-grinder.json"

[accounts.player]
kind = "agent"
space = 32

[accounts.oracle]
kind = "shared"
space = 50
owner = { pubkey = "FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH" }

[instructions]
mine = { action = "mine" }

[state_mapping]
"player.gold" = "player.gold"

[actions.mine]
takes = []

[observations]
"player.gold" = "uint"

[personas.grinder]
action_rate_multiplier = 1.0
action_weights = { mine = 1.0 }

[[oracles]]
name = "price_feed"
kind = "pyth"
account = "oracle"
base_price = 100.0
exponent = 0
"#;
        let adapter = parse_adapter_str(toml_str, "generic.toml").unwrap();
        let oracle_account = adapter.accounts.get("oracle").unwrap();
        let owner = oracle_account.owner.as_ref().expect("owner present");
        assert_eq!(
            owner.pubkey.as_deref(),
            Some("FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH")
        );
        assert!(owner.program_so.is_none());
    }

    #[test]
    fn rejects_agent_account_with_external_owner() {
        let toml_str = sample_generic_toml().replace(
            "[accounts.player]\nkind = \"agent\"\nspace = 32",
            "[accounts.player]\nkind = \"agent\"\nspace = 32\nowner = { pubkey = \"FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH\" }",
        );
        let err = parse_adapter_str(&toml_str, "owner.toml").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("[accounts].player.owner"), "got: {msg}");
        assert!(msg.contains("kind = \"agent\""), "got: {msg}");
    }

    #[test]
    fn rejects_ambiguous_owner_metadata() {
        let toml_str = sample_generic_toml().replace(
            "[accounts.marketplace]\nkind = \"shared\"\nspace = 512",
            "[accounts.marketplace]\nkind = \"shared\"\nspace = 512\nowner = { program_so = \"foo.so\", pubkey = \"FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH\" }",
        );
        let err = parse_adapter_str(&toml_str, "owner.toml").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("[accounts].marketplace.owner"), "got: {msg}");
        assert!(msg.contains("both"), "got: {msg}");
    }

    #[test]
    fn rejects_empty_owner_block() {
        let toml_str = sample_generic_toml().replace(
            "[accounts.marketplace]\nkind = \"shared\"\nspace = 512",
            "[accounts.marketplace]\nkind = \"shared\"\nspace = 512\nowner = {}",
        );
        let err = parse_adapter_str(&toml_str, "owner.toml").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("[accounts].marketplace.owner"), "got: {msg}");
        assert!(msg.contains("empty `owner` block"), "got: {msg}");
    }

    #[test]
    fn rejects_owner_pubkey_not_base58() {
        let toml_str = sample_generic_toml().replace(
            "[accounts.marketplace]\nkind = \"shared\"\nspace = 512",
            "[accounts.marketplace]\nkind = \"shared\"\nspace = 512\nowner = { pubkey = \"not-a-pubkey\" }",
        );
        let err = parse_adapter_str(&toml_str, "owner.toml").unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("[accounts].marketplace.owner.pubkey"),
            "got: {msg}"
        );
    }

    #[test]
    fn rejects_generic_oracle_bound_to_agent_account() {
        let toml_str = r#"
protocol = "generic"
program_so = "programs/resource_grinder/target/deploy/resource_grinder.so"
idl_path = "fixtures/idls/resource-grinder.json"

[accounts.player]
kind = "agent"
space = 50

[instructions]
mine = { action = "mine" }

[state_mapping]
"player.gold" = "player.gold"

[actions.mine]
takes = []

[observations]
"player.gold" = "uint"

[personas.grinder]
action_rate_multiplier = 1.0
action_weights = { mine = 1.0 }

[[oracles]]
name = "price_feed"
kind = "admin-mock"
account = "player"
"#;
        let err = parse_adapter_str(toml_str, "oracle.toml").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("[[oracles]][0].account"), "got: {msg}");
        assert!(msg.contains("kind = \"shared\""), "got: {msg}");
    }

    #[test]
    fn rejects_generic_oracle_without_account_binding() {
        let toml_str = r#"
protocol = "generic"
program_so = "programs/resource_grinder/target/deploy/resource_grinder.so"
idl_path = "fixtures/idls/resource-grinder.json"

[accounts.player]
kind = "agent"
space = 32

[instructions]
mine = { action = "mine" }

[state_mapping]
"player.gold" = "player.gold"

[actions.mine]
takes = []

[observations]
"player.gold" = "uint"

[personas.grinder]
action_rate_multiplier = 1.0
action_weights = { mine = 1.0 }

[[oracles]]
name = "price_feed"
kind = "admin-mock"
"#;
        let err = parse_adapter_str(toml_str, "oracle.toml").unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("[[oracles]][0].account"), "got: {msg}");
        assert!(msg.contains("shared"), "got: {msg}");
    }

    #[test]
    fn existing_shipped_adapters_parse_without_owner_metadata() {
        for name in ["lending", "perpetuals", "amm"] {
            let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("fixtures")
                .join("adapters")
                .join(format!("{name}.toml"));
            let adapter = load_adapter(&fixture)
                .unwrap_or_else(|e| panic!("shipped `{name}` adapter should load: {e}"));
            for account in adapter.accounts.values() {
                assert!(
                    account.owner.is_none(),
                    "shipped `{name}` adapter account should parse without `owner` metadata"
                );
            }
        }
    }

    #[test]
    fn loads_shipped_lending_fixture() {
        let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("fixtures")
            .join("adapters")
            .join("lending.toml");
        let adapter =
            load_adapter(&fixture).unwrap_or_else(|e| panic!("fixture adapter should load: {e}"));
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

    #[test]
    fn lineage_with_control_chars_rejected() {
        // Adapter-supplied lineage strings flow into the
        // `riptide lineage` reviewer-facing output, so the loader
        // applies the same ANSI-injection guard every other
        // adapter-supplied label passes through.
        let toml = "\
protocol = \"lending\"

[instructions]
deposit = { action = \"deposit\", amount = \"amount\" }

[state_mapping]
\"pool.total_deposits\" = \"tvl\"

[lineage]
inferred_assumptions = [\"malicious\\u001bprose\"]
";
        let err = parse_adapter_str(toml, "lineage-ansi.toml")
            .expect_err("control chars in lineage must be rejected");
        let message = err.to_string();
        assert!(
            message.contains("[lineage].inferred_assumptions"),
            "error must name the offending key: {message}",
        );
    }

    #[test]
    fn lineage_idl_source_with_repo_path_accepted() {
        let toml = r#"
protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"

[lineage]
idl_source = "programs/lending_pool/src/state.rs"
generator = "hand-authored"
"#;
        let adapter =
            parse_adapter_str(toml, "lineage-ok.toml").expect("well-formed lineage must parse");
        let lineage = adapter.lineage.expect("lineage block present");
        assert_eq!(
            lineage.idl_source.as_deref(),
            Some("programs/lending_pool/src/state.rs"),
        );
        assert_eq!(lineage.generator.as_deref(), Some("hand-authored"));
    }

    #[test]
    fn lineage_text_byte_cap_is_utf8_bytes_not_char_count() {
        // Pin the engine side of the CLI+engine byte-length parity. An
        // entry of 512 'é' is exactly 1024 UTF-8 bytes (at the cap) and
        // must be accepted; 513 of them is 1026 bytes (over) and must
        // be rejected. The CLI has a mirrored test — both validators
        // must agree on the same boundary for every adapter author.
        let accepted_entry = "é".repeat(512);
        assert_eq!(accepted_entry.len(), 1024);
        let accepted_toml = format!(
            "\
protocol = \"lending\"

[instructions]
deposit = {{ action = \"deposit\", amount = \"amount\" }}

[state_mapping]
\"pool.total_deposits\" = \"tvl\"

[lineage]
inferred_assumptions = [\"{accepted_entry}\"]
"
        );
        parse_adapter_str(&accepted_toml, "lineage-utf8-at-cap.toml")
            .expect("entry of exactly 1024 UTF-8 bytes must be accepted");

        let rejected_entry = "é".repeat(513);
        assert_eq!(rejected_entry.len(), 1026);
        let rejected_toml = format!(
            "\
protocol = \"lending\"

[instructions]
deposit = {{ action = \"deposit\", amount = \"amount\" }}

[state_mapping]
\"pool.total_deposits\" = \"tvl\"

[lineage]
inferred_assumptions = [\"{rejected_entry}\"]
"
        );
        let err = parse_adapter_str(&rejected_toml, "lineage-utf8-over-cap.toml")
            .expect_err("entry of 1026 UTF-8 bytes must be rejected");
        let message = err.to_string();
        assert!(
            message.contains("[lineage].inferred_assumptions"),
            "error must name the offending key: {message}",
        );
    }
}
