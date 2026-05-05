//! Replay state import packs.
//!
//! This module reads **IN** account state for replay bootstrapping from a
//! fixture pack declared by `[semantics.replay]`. That is deliberately
//! different from the reviewer evidence pack emitted **OUT** after a run by
//! `crate::pack`: evidence packs summarize and prove a completed simulation,
//! while state-import packs are deterministic inputs consumed before replay
//! execution starts.
//!
//! Runtime integration is intentionally not wired here. Callers can load the
//! pack, inspect the typed provenance, and then seed their chosen backend with
//! the returned accounts. `mainnet-rpc` is a typed runtime error in v1 so users
//! get a stable diagnostic that points them at fixture export via
//! `riptide pack-state`.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    str::FromStr,
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_sdk::pubkey::Pubkey;

use crate::adapter::{ReplayBlock, ReplayStateSource};

pub const MAINNET_RPC_NOT_IMPLEMENTED_MESSAGE: &str =
    "mainnet-rpc state import is not implemented in v1; export your accounts to a fixture pack via `riptide pack-state` (planned for a future release)";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StateImportError {
    MissingStateSource,
    UnknownReplayStateSource {
        state_source: String,
    },
    MissingReplayPackPath,
    UnsafeReplayPackPath {
        pack_path: String,
    },
    UnsafeStatePackAccountPath {
        account_pubkey: String,
        path: String,
    },
    MissingStatePackAccountPubkey {
        account_key: String,
    },
    SlotSourceInconsistency {
        slot: u64,
        source_slot: u64,
    },
    MainnetRpcNotImplemented {
        message: &'static str,
    },
    ManifestRead {
        path: PathBuf,
        source: String,
    },
    ManifestParse {
        path: PathBuf,
        source: String,
    },
    InvalidSlot {
        expected: u64,
        actual: u64,
    },
    MissingManifestAccount {
        role: String,
    },
    UnexpectedManifestAccount {
        role: String,
    },
    MissingSha256Hash {
        role: String,
    },
    MalformedSha256Hash {
        role: String,
        sha256_hash: String,
    },
    AccountRead {
        role: String,
        path: PathBuf,
        source: String,
    },
    Sha256Mismatch {
        role: String,
        path: PathBuf,
        expected: String,
        actual: String,
    },
    AccountParse {
        role: String,
        path: PathBuf,
        source: String,
    },
    AccountDecode {
        role: String,
        path: PathBuf,
        source: String,
    },
    AccountCountMismatch {
        role: String,
        found: usize,
    },
    InvalidRoleName {
        role: String,
    },
    InvalidPubkey {
        role: String,
        field: &'static str,
        value: String,
        source: String,
    },
    AccountPubkeyMismatch {
        role: String,
        source: &'static str,
        expected: String,
        actual: String,
    },
}

impl std::fmt::Display for StateImportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingStateSource => write!(
                f,
                "MissingStateSource; replay state import requires `state_source = \"fixture\"` or `state_source = \"mainnet-rpc\"`"
            ),
            Self::UnknownReplayStateSource { state_source } => write!(
                f,
                "UnknownReplayStateSource({state_source}); expected `fixture` or `mainnet-rpc`"
            ),
            Self::MissingReplayPackPath => write!(
                f,
                "MissingReplayPackPath; fixture replay state import requires `pack_path = \"<relative-path>\"`"
            ),
            Self::UnsafeReplayPackPath { pack_path } => write!(
                f,
                "UnsafeReplayPackPath({pack_path}); pack_path must be relative and free of path traversal"
            ),
            Self::UnsafeStatePackAccountPath {
                account_pubkey,
                path,
            } => write!(
                f,
                "UnsafeStatePackAccountPath({account_pubkey}); account path `{path}` must be relative and free of path traversal"
            ),
            Self::MissingStatePackAccountPubkey { account_key } => write!(
                f,
                "MissingStatePackAccountPubkey({account_key}); state-pack manifest account entries must declare account_pubkey"
            ),
            Self::SlotSourceInconsistency { slot, source_slot } => write!(
                f,
                "StatePackSlotSourceInconsistency; manifest slot {slot} does not match source.slot {source_slot}"
            ),
            Self::MainnetRpcNotImplemented { message } => {
                write!(f, "MainnetRpcNotImplemented; {message}")
            }
            Self::ManifestRead { path, source } => {
                write!(f, "{}: failed to read manifest.json: {source}", path.display())
            }
            Self::ManifestParse { path, source } => {
                write!(f, "{}: failed to parse manifest.json: {source}", path.display())
            }
            Self::InvalidSlot { expected, actual } => write!(
                f,
                "InvalidReplayStateSlot; replay declared slot {expected}, but state pack manifest declares {actual}"
            ),
            Self::MissingManifestAccount { role } => write!(
                f,
                "MissingManifestAccount({role}); manifest.json must declare every replay role"
            ),
            Self::UnexpectedManifestAccount { role } => write!(
                f,
                "UnexpectedManifestAccount({role}); manifest.json declares an account not requested by replay roles"
            ),
            Self::MissingSha256Hash { role } => write!(
                f,
                "MissingSha256Hash({role}); manifest.json account entries must declare sha256_hash"
            ),
            Self::MalformedSha256Hash { role, sha256_hash } => write!(
                f,
                "MalformedSha256Hash({role}); expected 64 lowercase hex chars, got `{sha256_hash}`"
            ),
            Self::AccountRead { role, path, source } => write!(
                f,
                "{}: failed to read accounts/{role}.json: {source}",
                path.display()
            ),
            Self::Sha256Mismatch {
                role,
                path,
                expected,
                actual,
            } => write!(
                f,
                "{}: Sha256Mismatch({role}); expected {expected}, got {actual}",
                path.display()
            ),
            Self::AccountParse { role, path, source } => write!(
                f,
                "{}: failed to parse accounts/{role}.json: {source}",
                path.display()
            ),
            Self::AccountDecode { role, path, source } => write!(
                f,
                "{}: failed to decode accounts/{role}.json data_b64: {source}",
                path.display()
            ),
            Self::AccountCountMismatch { role, found } => write!(
                f,
                "AccountCountMismatch({role}); expected one or more accounts for the role-bound loader, found {found}"
            ),
            Self::InvalidRoleName { role } => write!(
                f,
                "InvalidRoleName({role}); replay state account roles must match `[a-z][a-z0-9_]*`"
            ),
            Self::InvalidPubkey {
                role,
                field,
                value,
                source,
            } => write!(
                f,
                "InvalidPubkey({role}.{field}); `{value}` is not a valid base58-encoded 32-byte pubkey: {source}"
            ),
            Self::AccountPubkeyMismatch {
                role,
                source,
                expected,
                actual,
            } => write!(
                f,
                "AccountPubkeyMismatch({role}); replay roles declared {expected}, but {source} declares {actual}"
            ),
        }
    }
}

impl std::error::Error for StateImportError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayStateImport {
    pub pack_path: PathBuf,
    pub accounts: BTreeMap<String, Vec<ImportedReplayAccount>>,
    pub provenance: ReplayStateProvenance,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedReplayAccount {
    pub role: String,
    pub pubkey: Pubkey,
    pub account: Account,
    pub sha256_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatePackImport {
    pub pack_path: PathBuf,
    pub accounts: Vec<ImportedStatePackAccount>,
    pub provenance: ReplayStateProvenance,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedStatePackAccount {
    pub pubkey: Pubkey,
    pub account: Account,
    pub sha256_hash: String,
    pub account_name: Option<String>,
    pub role: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplayStateProvenance {
    pub pack_path: String,
    pub slot: u64,
    pub accounts: BTreeMap<String, ReplayStateAccountProvenance>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplayStateAccountProvenance {
    pub account_pubkey: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub account_pubkeys: Vec<String>,
    pub sha256_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
struct StatePackManifest {
    version: u32,
    slot: u64,
    accounts: BTreeMap<String, ManifestAccount>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestAccount {
    account_pubkey: String,
    #[serde(default)]
    sha256_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
struct CurrentStatePackManifest {
    version: u32,
    slot: u64,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    source: Option<Value>,
    #[serde(default)]
    warnings: Vec<String>,
    accounts: BTreeMap<String, CurrentManifestAccount>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
struct CurrentManifestAccount {
    #[serde(default)]
    account_pubkey: Option<String>,
    #[serde(default)]
    pubkey: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    sha256_hash: Option<String>,
    #[serde(default)]
    account_name: Option<String>,
    #[serde(default)]
    role: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
struct AccountFixture {
    #[serde(alias = "account_pubkey")]
    pubkey: String,
    owner: String,
    lamports: u64,
    executable: bool,
    rent_epoch: u64,
    data_b64: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
enum AccountFixtureFile {
    One(AccountFixture),
    Many(Vec<AccountFixture>),
}

pub fn import_replay_state(
    replay: &ReplayBlock,
    base_dir: &Path,
) -> Result<ReplayStateImport, StateImportError> {
    match replay_state_source(replay)? {
        ReplayStateSource::Fixture => load_fixture_pack(replay, base_dir),
        ReplayStateSource::MainnetRpc => Err(StateImportError::MainnetRpcNotImplemented {
            message: MAINNET_RPC_NOT_IMPLEMENTED_MESSAGE,
        }),
    }
}

/// Load a current-state pack produced by `riptide pack-state`.
///
/// Unlike `[semantics.replay]` fixture packs, this loader is not role-bound:
/// every account declared in the manifest is hydrated into LiteSVM before
/// tick 0. Optional `account_name` / `role` metadata can be used by callers
/// to bind imported pubkeys back into adapter account registries.
pub fn load_state_pack(pack_path: &Path) -> Result<StatePackImport, StateImportError> {
    let manifest_path = pack_path.join("manifest.json");
    let manifest_raw =
        fs::read(&manifest_path).map_err(|source| StateImportError::ManifestRead {
            path: manifest_path.clone(),
            source: source.to_string(),
        })?;
    let manifest: CurrentStatePackManifest =
        serde_json::from_slice(&manifest_raw).map_err(|source| {
            StateImportError::ManifestParse {
                path: manifest_path.clone(),
                source: source.to_string(),
            }
        })?;

    if manifest.version != 1 {
        return Err(StateImportError::ManifestParse {
            path: manifest_path,
            source: format!("unsupported state pack version {}", manifest.version),
        });
    }
    if let Some(source_slot) = manifest
        .source
        .as_ref()
        .and_then(|source| source.get("slot"))
        .and_then(Value::as_u64)
    {
        if source_slot != manifest.slot {
            return Err(StateImportError::SlotSourceInconsistency {
                slot: manifest.slot,
                source_slot,
            });
        }
    }

    let mut accounts = Vec::new();
    let mut provenance_accounts = BTreeMap::new();

    for (account_key, manifest_account) in &manifest.accounts {
        let account_pubkey = manifest_account
            .account_pubkey
            .as_deref()
            .or(manifest_account.pubkey.as_deref())
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| StateImportError::MissingStatePackAccountPubkey {
                account_key: account_key.clone(),
            })?;
        let expected_pubkey = parse_pubkey(account_key, "account_pubkey", account_pubkey)?;
        if is_probable_pubkey(account_key) && account_key != account_pubkey {
            return Err(StateImportError::AccountPubkeyMismatch {
                role: account_key.clone(),
                source: "manifest.json",
                expected: account_key.clone(),
                actual: account_pubkey.to_string(),
            });
        }

        let expected_hash = manifest_account
            .sha256_hash
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| StateImportError::MissingSha256Hash {
                role: account_pubkey.to_string(),
            })?;
        validate_sha256_hash(account_pubkey, expected_hash)?;

        let account_rel_path = manifest_account
            .path
            .clone()
            .unwrap_or_else(|| format!("accounts/{account_pubkey}.json"));
        if !is_safe_relative_path(&account_rel_path) {
            return Err(StateImportError::UnsafeStatePackAccountPath {
                account_pubkey: account_pubkey.to_string(),
                path: account_rel_path,
            });
        }
        let path = pack_path.join(&account_rel_path);
        let raw = fs::read(&path).map_err(|source| StateImportError::AccountRead {
            role: account_pubkey.to_string(),
            path: path.clone(),
            source: source.to_string(),
        })?;
        let actual_hash = sha256_hex(&raw);
        if actual_hash != expected_hash {
            return Err(StateImportError::Sha256Mismatch {
                role: account_pubkey.to_string(),
                path,
                expected: expected_hash.to_string(),
                actual: actual_hash,
            });
        }

        let fixture_file: AccountFixtureFile =
            serde_json::from_slice(&raw).map_err(|source| StateImportError::AccountParse {
                role: account_pubkey.to_string(),
                path: path.clone(),
                source: source.to_string(),
            })?;
        let fixtures = match fixture_file {
            AccountFixtureFile::One(fixture) => vec![fixture],
            AccountFixtureFile::Many(fixtures) => fixtures,
        };
        if fixtures.is_empty() {
            return Err(StateImportError::AccountCountMismatch {
                role: account_pubkey.to_string(),
                found: 0,
            });
        }

        let mut fixture_pubkeys = Vec::with_capacity(fixtures.len());
        for fixture in fixtures {
            let fixture_pubkey = parse_pubkey(account_pubkey, "account_pubkey", &fixture.pubkey)?;
            fixture_pubkeys.push(fixture.pubkey.clone());
            if fixture_pubkey != expected_pubkey {
                return Err(StateImportError::AccountPubkeyMismatch {
                    role: account_pubkey.to_string(),
                    source: "accounts/<pubkey>.json",
                    expected: account_pubkey.to_string(),
                    actual: fixture.pubkey.clone(),
                });
            }
            let owner = parse_pubkey(account_pubkey, "owner", &fixture.owner)?;
            let data = BASE64_STANDARD
                .decode(&fixture.data_b64)
                .map_err(|source| StateImportError::AccountDecode {
                    role: account_pubkey.to_string(),
                    path: path.clone(),
                    source: source.to_string(),
                })?;
            accounts.push(ImportedStatePackAccount {
                pubkey: fixture_pubkey,
                account: Account {
                    lamports: fixture.lamports,
                    data,
                    owner,
                    executable: fixture.executable,
                    rent_epoch: fixture.rent_epoch,
                },
                sha256_hash: expected_hash.to_string(),
                account_name: manifest_account.account_name.clone(),
                role: manifest_account.role.clone(),
            });
        }

        provenance_accounts.insert(
            account_pubkey.to_string(),
            ReplayStateAccountProvenance {
                account_pubkey: account_pubkey.to_string(),
                account_pubkeys: fixture_pubkeys,
                sha256_hash: expected_hash.to_string(),
            },
        );
    }

    let mut warnings = manifest.warnings;
    match manifest.mode.as_deref() {
        Some("current-from-tx-discovery") => warnings.push(
            "`--tx` state packs use the transaction only for account discovery; account bytes are current RPC state, not historical pre-state.".into(),
        ),
        Some("current-from-explicit-accounts") | None => {}
        Some(other) => warnings.push(format!(
            "state pack mode `{other}` is not known to this engine; accounts were still hash-checked and imported"
        )),
    }

    Ok(StatePackImport {
        pack_path: pack_path.to_path_buf(),
        accounts,
        provenance: ReplayStateProvenance {
            pack_path: pack_path.display().to_string(),
            slot: manifest.slot,
            accounts: provenance_accounts,
        },
        warnings,
    })
}

fn replay_state_source(replay: &ReplayBlock) -> Result<ReplayStateSource, StateImportError> {
    if let Some(source) = replay.state_source_ref {
        return Ok(source);
    }
    let state_source = replay
        .state_source
        .as_deref()
        .ok_or(StateImportError::MissingStateSource)?;
    ReplayStateSource::parse(state_source).ok_or_else(|| {
        StateImportError::UnknownReplayStateSource {
            state_source: state_source.to_string(),
        }
    })
}

fn load_fixture_pack(
    replay: &ReplayBlock,
    base_dir: &Path,
) -> Result<ReplayStateImport, StateImportError> {
    let pack_path = replay
        .pack_path
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or(StateImportError::MissingReplayPackPath)?;
    if !is_safe_relative_path(pack_path) {
        return Err(StateImportError::UnsafeReplayPackPath {
            pack_path: pack_path.to_string(),
        });
    }

    for role in replay.roles.keys() {
        validate_role_name(role)?;
    }

    let resolved_pack_path = base_dir.join(pack_path);
    let manifest_path = resolved_pack_path.join("manifest.json");
    let manifest_raw =
        fs::read(&manifest_path).map_err(|source| StateImportError::ManifestRead {
            path: manifest_path.clone(),
            source: source.to_string(),
        })?;
    let manifest: StatePackManifest = serde_json::from_slice(&manifest_raw).map_err(|source| {
        StateImportError::ManifestParse {
            path: manifest_path.clone(),
            source: source.to_string(),
        }
    })?;

    if manifest.version != 1 {
        return Err(StateImportError::ManifestParse {
            path: manifest_path,
            source: format!("unsupported state pack version {}", manifest.version),
        });
    }

    if let Some(expected_slot) = replay.slot {
        if expected_slot != manifest.slot {
            return Err(StateImportError::InvalidSlot {
                expected: expected_slot,
                actual: manifest.slot,
            });
        }
    }

    for role in manifest.accounts.keys() {
        validate_role_name(role)?;
        if !replay.roles.contains_key(role) {
            return Err(StateImportError::UnexpectedManifestAccount { role: role.clone() });
        }
    }

    let mut accounts = BTreeMap::new();
    let mut provenance_accounts = BTreeMap::new();

    for (role, expected_pubkey) in &replay.roles {
        let manifest_account = manifest
            .accounts
            .get(role)
            .ok_or_else(|| StateImportError::MissingManifestAccount { role: role.clone() })?;
        let expected_hash = manifest_account
            .sha256_hash
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| StateImportError::MissingSha256Hash { role: role.clone() })?;
        validate_sha256_hash(role, expected_hash)?;

        if manifest_account.account_pubkey != *expected_pubkey {
            return Err(StateImportError::AccountPubkeyMismatch {
                role: role.clone(),
                source: "manifest.json",
                expected: expected_pubkey.clone(),
                actual: manifest_account.account_pubkey.clone(),
            });
        }

        let path = resolved_pack_path
            .join("accounts")
            .join(format!("{role}.json"));
        let raw = fs::read(&path).map_err(|source| StateImportError::AccountRead {
            role: role.clone(),
            path: path.clone(),
            source: source.to_string(),
        })?;
        let actual_hash = sha256_hex(&raw);
        if actual_hash != expected_hash {
            return Err(StateImportError::Sha256Mismatch {
                role: role.clone(),
                path,
                expected: expected_hash.to_string(),
                actual: actual_hash,
            });
        }

        let fixtures: Vec<AccountFixture> =
            serde_json::from_slice(&raw).map_err(|source| StateImportError::AccountParse {
                role: role.clone(),
                path: path.clone(),
                source: source.to_string(),
            })?;
        if fixtures.is_empty() {
            return Err(StateImportError::AccountCountMismatch {
                role: role.clone(),
                found: fixtures.len(),
            });
        }
        let account_pubkeys: Vec<String> = fixtures
            .iter()
            .map(|fixture| fixture.pubkey.clone())
            .collect();
        if !account_pubkeys
            .iter()
            .any(|pubkey| pubkey == expected_pubkey)
        {
            return Err(StateImportError::AccountPubkeyMismatch {
                role: role.clone(),
                source: "accounts/<role>.json",
                expected: expected_pubkey.clone(),
                actual: account_pubkeys.join(","),
            });
        }

        let mut role_accounts = Vec::with_capacity(fixtures.len());
        for fixture in fixtures {
            let pubkey = parse_pubkey(role, "account_pubkey", &fixture.pubkey)?;
            let owner = parse_pubkey(role, "owner", &fixture.owner)?;
            let data = BASE64_STANDARD
                .decode(&fixture.data_b64)
                .map_err(|source| StateImportError::AccountDecode {
                    role: role.clone(),
                    path: path.clone(),
                    source: source.to_string(),
                })?;
            let account = Account {
                lamports: fixture.lamports,
                data,
                owner,
                executable: fixture.executable,
                rent_epoch: fixture.rent_epoch,
            };
            role_accounts.push(ImportedReplayAccount {
                role: role.clone(),
                pubkey,
                account,
                sha256_hash: expected_hash.to_string(),
            });
        }
        accounts.insert(role.clone(), role_accounts);
        provenance_accounts.insert(
            role.clone(),
            ReplayStateAccountProvenance {
                account_pubkey: expected_pubkey.clone(),
                account_pubkeys,
                sha256_hash: expected_hash.to_string(),
            },
        );
    }

    Ok(ReplayStateImport {
        pack_path: resolved_pack_path,
        accounts,
        provenance: ReplayStateProvenance {
            pack_path: pack_path.to_string(),
            slot: manifest.slot,
            accounts: provenance_accounts,
        },
    })
}

fn parse_pubkey(role: &str, field: &'static str, value: &str) -> Result<Pubkey, StateImportError> {
    Pubkey::from_str(value).map_err(|source| StateImportError::InvalidPubkey {
        role: role.to_string(),
        field,
        value: value.to_string(),
        source: source.to_string(),
    })
}

fn validate_role_name(role: &str) -> Result<(), StateImportError> {
    let mut chars = role.chars();
    let Some(first) = chars.next() else {
        return Err(StateImportError::InvalidRoleName { role: role.into() });
    };
    if first.is_ascii_lowercase()
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    {
        Ok(())
    } else {
        Err(StateImportError::InvalidRoleName { role: role.into() })
    }
}

fn validate_sha256_hash(role: &str, value: &str) -> Result<(), StateImportError> {
    if value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        Ok(())
    } else {
        Err(StateImportError::MalformedSha256Hash {
            role: role.to_string(),
            sha256_hash: value.to_string(),
        })
    }
}

fn is_probable_pubkey(value: &str) -> bool {
    Pubkey::from_str(value).is_ok()
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("{digest:x}")
}

fn is_safe_relative_path(value: &str) -> bool {
    let path = Path::new(value);
    !path.is_absolute()
        && !value.chars().any(is_terminal_control)
        && path
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
}

fn is_terminal_control(ch: char) -> bool {
    (ch as u32) < 0x20 || (ch as u32) == 0x7f || ((ch as u32) >= 0x80 && (ch as u32) < 0xa0)
}
