// Adapted from Trident (MIT) — https://github.com/Ackee-Blockchain/trident

use std::{
    fs,
    path::{Path, PathBuf},
    str::FromStr,
    time::Duration,
};

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use solana_account::Account;
use solana_sdk::pubkey::Pubkey;

use crate::World;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BootstrapReport {
    pub programs_loaded: usize,
    pub accounts_loaded: usize,
    pub accounts_forked: usize,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct SimManifest {
    #[serde(default)]
    pub sim: SimBootstrap,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct SimBootstrap {
    #[serde(default)]
    pub programs: Vec<ProgramEntry>,
    #[serde(default)]
    pub accounts: Vec<AccountEntry>,
    #[serde(default)]
    pub fork: Vec<ForkEntry>,
    #[serde(default)]
    pub metrics: MetricsConfig,
    #[serde(default)]
    pub regression: RegressionConfig,
    #[serde(default)]
    pub coverage: CoverageConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProgramEntry {
    pub address: Option<String>,
    pub program: String,
    pub loader: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountEntry {
    pub address: String,
    pub filename: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ForkEntry {
    pub address: String,
    #[serde(default = "default_cluster")]
    pub cluster: String,
    pub filename: Option<String>,
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct MetricsConfig {
    #[serde(default)]
    pub enabled: bool,
    pub filename: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct RegressionConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub accounts: Vec<String>,
    #[serde(default)]
    pub state_hashes: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct CoverageConfig {
    #[serde(default)]
    pub enabled: bool,
}

pub fn apply_manifest(
    world: &mut World,
    manifest_path: impl AsRef<Path>,
) -> Result<BootstrapReport> {
    let manifest_path = manifest_path.as_ref();
    let raw = fs::read_to_string(manifest_path)
        .with_context(|| format!("read sim manifest {}", manifest_path.display()))?;
    let manifest: SimManifest = toml::from_str(&raw)
        .with_context(|| format!("parse sim manifest {}", manifest_path.display()))?;
    apply_bootstrap(
        world,
        &manifest.sim,
        manifest_path.parent().unwrap_or(Path::new(".")),
    )
}

pub fn apply_manifest_if_exists(
    world: &mut World,
    manifest_path: impl AsRef<Path>,
) -> Result<Option<BootstrapReport>> {
    let manifest_path = manifest_path.as_ref();
    if !manifest_path.exists() {
        return Ok(None);
    }
    apply_manifest(world, manifest_path).map(Some)
}

pub fn apply_bootstrap(
    world: &mut World,
    bootstrap: &SimBootstrap,
    base_dir: impl AsRef<Path>,
) -> Result<BootstrapReport> {
    let base_dir = base_dir.as_ref();
    let mut report = BootstrapReport::default();

    if bootstrap.metrics.enabled {
        bail!("sim.metrics.enabled is declared, but guided-sim metrics artifacts are not implemented yet");
    }
    if bootstrap.regression.enabled {
        bail!("sim.regression.enabled is declared, but guided-sim regression artifacts are not implemented yet");
    }
    if bootstrap.coverage.enabled {
        bail!("sim.coverage.enabled is declared, but guided-sim coverage output is not implemented yet");
    }

    for program in &bootstrap.programs {
        if let Some(loader) = &program.loader {
            if loader != "direct" {
                bail!(
                    "unsupported sim.programs loader `{loader}`; only `direct` local .so loading is supported"
                );
            }
        }
        let program_path = resolve_path(base_dir, &program.program);
        match &program.address {
            Some(address) => {
                let program_id = parse_pubkey(address)?;
                world.add_program_from_so(program_id, &program_path)?;
            }
            None => {
                world.load_program_from_so(&program_path)?;
            }
        }
        report.programs_loaded += 1;
    }

    for account in &bootstrap.accounts {
        let address = parse_pubkey(&account.address)?;
        let account_path = resolve_path(base_dir, &account.filename);
        world.load_account_from_json_file(address, &account_path)?;
        report.accounts_loaded += 1;
    }

    for fork in &bootstrap.fork {
        let address = parse_pubkey(&fork.address)?;
        let cache_path = fork
            .filename
            .as_deref()
            .map(|filename| resolve_path(base_dir, filename))
            .unwrap_or_else(|| default_fork_cache_path(base_dir, &fork.cluster, &address));
        world.fork_account_to_json_cache(address, &fork.cluster, &cache_path, fork.overwrite)?;
        report.accounts_forked += 1;
    }

    Ok(report)
}

pub fn read_account_snapshot(path: impl AsRef<Path>) -> Result<Account> {
    read_account_snapshot_inner(path).map(|(_, account)| account)
}

pub fn read_account_snapshot_for_pubkey(
    path: impl AsRef<Path>,
    expected_pubkey: &Pubkey,
) -> Result<Account> {
    let (declared_pubkey, account) = read_account_snapshot_inner(path)?;
    if let Some(declared_pubkey) = declared_pubkey {
        if declared_pubkey != *expected_pubkey {
            bail!(
                "account snapshot pubkey {declared_pubkey} does not match manifest address {expected_pubkey}"
            );
        }
    }
    Ok(account)
}

fn read_account_snapshot_inner(path: impl AsRef<Path>) -> Result<(Option<Pubkey>, Account)> {
    let path = path.as_ref();
    let raw = fs::read_to_string(path)
        .with_context(|| format!("read account snapshot {}", path.display()))?;
    let value: Value = serde_json::from_str(&raw)
        .with_context(|| format!("parse account snapshot {}", path.display()))?;
    let declared_pubkey = value
        .get("pubkey")
        .and_then(Value::as_str)
        .map(parse_pubkey)
        .transpose()
        .with_context(|| format!("decode account snapshot pubkey {}", path.display()))?;
    let account = parse_account_from_json(&value)
        .with_context(|| format!("decode account snapshot {}", path.display()))?;
    Ok((declared_pubkey, account))
}

pub fn write_account_snapshot(
    pubkey: &Pubkey,
    account: &Account,
    path: impl AsRef<Path>,
) -> Result<()> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create account snapshot dir {}", parent.display()))?;
    }
    let value = json!({
        "pubkey": pubkey.to_string(),
        "account": {
            "lamports": account.lamports,
            "data": [BASE64.encode(&account.data), "base64"],
            "owner": account.owner.to_string(),
            "executable": account.executable,
            "rentEpoch": account.rent_epoch,
        }
    });
    fs::write(
        path,
        serde_json::to_vec_pretty(&value).expect("account snapshot serializes"),
    )
    .with_context(|| format!("write account snapshot {}", path.display()))
}

pub fn load_or_fetch_account(
    address: &Pubkey,
    cluster: &str,
    cache_path: impl AsRef<Path>,
    overwrite: bool,
) -> Result<Account> {
    let cache_path = cache_path.as_ref();
    if cache_path.exists() && !overwrite {
        return read_account_snapshot_for_pubkey(cache_path, address);
    }

    let account = fetch_account(address, cluster)?;
    write_account_snapshot(address, &account, cache_path)?;
    Ok(account)
}

pub fn fetch_account(address: &Pubkey, cluster: &str) -> Result<Account> {
    let url = cluster_url(cluster);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .context("build RPC client")?;
    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getAccountInfo",
        "params": [
            address.to_string(),
            {
                "encoding": "base64",
                "commitment": "confirmed"
            }
        ]
    });
    let response: Value = client
        .post(url)
        .json(&request)
        .send()
        .with_context(|| format!("fetch account {address} from {url}"))?
        .error_for_status()
        .with_context(|| format!("fetch account {address} from {url}"))?
        .json()
        .with_context(|| format!("decode RPC response for account {address} from {url}"))?;

    if let Some(error) = response.get("error") {
        bail!("RPC returned error for account {address} from {url}: {error}");
    }

    let value = response.pointer("/result/value").ok_or_else(|| {
        anyhow!("RPC response for account {address} from {url} is missing result.value")
    })?;
    if value.is_null() {
        bail!("account {address} does not exist on {url}");
    }
    parse_account_value(value)
}

fn parse_account_from_json(value: &Value) -> Result<Account> {
    if let Some(account) = value.get("account") {
        return parse_account_value(account);
    }
    if let Some(account) = value.pointer("/result/value") {
        if account.is_null() {
            bail!("account snapshot has null result.value");
        }
        return parse_account_value(account);
    }
    parse_account_value(value)
}

fn parse_account_value(value: &Value) -> Result<Account> {
    let lamports = required_u64(value, "lamports")?;
    let owner = parse_pubkey(required_str(value, "owner")?)?;
    let executable = value
        .get("executable")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let rent_epoch = value
        .get("rentEpoch")
        .or_else(|| value.get("rent_epoch"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let data = parse_account_data(
        value
            .get("data")
            .ok_or_else(|| anyhow!("account snapshot is missing data"))?,
    )?;

    Ok(Account {
        lamports,
        data,
        owner,
        executable,
        rent_epoch,
    })
}

fn parse_account_data(value: &Value) -> Result<Vec<u8>> {
    if let Some(data) = value.as_str() {
        return BASE64
            .decode(data)
            .map_err(|error| anyhow!("base64 account data decode failed: {error}"));
    }

    if let Some(values) = value.as_array() {
        let data = values
            .first()
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("account data array must start with a base64 string"))?;
        let encoding = values
            .get(1)
            .and_then(Value::as_str)
            .unwrap_or("base64")
            .to_ascii_lowercase();
        if encoding != "base64" {
            bail!("unsupported account data encoding `{encoding}`; use base64 snapshots");
        }
        return BASE64
            .decode(data)
            .map_err(|error| anyhow!("base64 account data decode failed: {error}"));
    }

    if value.is_object() {
        bail!("parsed account JSON cannot be loaded; fetch or save accounts with base64 encoding");
    }

    bail!("account data must be a base64 string or [base64, encoding] array")
}

fn required_u64<'a>(value: &'a Value, field: &str) -> Result<u64> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow!("account snapshot is missing numeric field `{field}`"))
}

fn required_str<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("account snapshot is missing string field `{field}`"))
}

fn resolve_path(base_dir: &Path, value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        base_dir.join(path)
    }
}

fn default_fork_cache_path(base_dir: &Path, cluster: &str, address: &Pubkey) -> PathBuf {
    base_dir
        .join("fork-cache")
        .join(sanitize_path_segment(cluster))
        .join(format!("{address}.json"))
}

fn sanitize_path_segment(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn cluster_url(cluster: &str) -> &str {
    match cluster {
        "m" | "mainnet" | "mainnet-beta" => "https://api.mainnet-beta.solana.com",
        "d" | "devnet" => "https://api.devnet.solana.com",
        "t" | "testnet" => "https://api.testnet.solana.com",
        custom => custom,
    }
}

fn default_cluster() -> String {
    "mainnet".to_owned()
}

fn parse_pubkey(value: &str) -> Result<Pubkey> {
    Pubkey::from_str(value).map_err(|error| anyhow!("invalid pubkey `{value}`: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_loads_local_account_snapshot() {
        let root = unique_temp_dir();
        fs::create_dir_all(&root).unwrap();
        let address = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        fs::write(
            root.join("account.json"),
            serde_json::to_string(&json!({
                "account": {
                    "lamports": 42,
                    "data": [BASE64.encode([1u8, 2, 3]), "base64"],
                    "owner": owner.to_string(),
                    "executable": false,
                    "rentEpoch": 0
                }
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            root.join("Riptide.toml"),
            format!(
                "[[sim.accounts]]\naddress = \"{}\"\nfilename = \"account.json\"\n",
                address
            ),
        )
        .unwrap();

        let mut world = World::default();
        let report = apply_manifest(&mut world, root.join("Riptide.toml")).unwrap();
        let account = world.get_account(&address).unwrap();

        assert_eq!(report.accounts_loaded, 1);
        assert_eq!(account.lamports, 42);
        assert_eq!(account.owner, owner);
        assert_eq!(account.data, vec![1, 2, 3]);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn manifest_rejects_unknown_sections() {
        let root = unique_temp_dir();
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("Riptide.toml"),
            "[[sim.account]]\naddress = \"11111111111111111111111111111111\"\nfilename = \"account.json\"\n",
        )
        .unwrap();

        let mut world = World::default();
        let error = format!(
            "{:#}",
            apply_manifest(&mut world, root.join("Riptide.toml")).unwrap_err()
        );

        assert!(error.contains("parse sim manifest"), "got: {error}");
        assert!(error.contains("unknown field"), "got: {error}");
        assert!(error.contains("account"), "got: {error}");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn manifest_accepts_guarded_evidence_sections() {
        let manifest: SimManifest = toml::from_str(
            r#"
[sim.metrics]
enabled = false
filename = "artifacts/guided-sim-metrics.json"

[sim.regression]
enabled = false
accounts = ["11111111111111111111111111111111"]
state_hashes = ["pool"]

[sim.coverage]
enabled = false
"#,
        )
        .unwrap();

        assert!(!manifest.sim.metrics.enabled);
        assert_eq!(
            manifest.sim.metrics.filename.as_deref(),
            Some("artifacts/guided-sim-metrics.json")
        );
        assert_eq!(manifest.sim.regression.accounts.len(), 1);
        assert_eq!(manifest.sim.regression.state_hashes, vec!["pool"]);
        assert!(!manifest.sim.coverage.enabled);
    }

    #[test]
    fn manifest_rejects_unsupported_program_loader() {
        let mut world = World::default();
        let bootstrap = SimBootstrap {
            programs: vec![ProgramEntry {
                address: None,
                program: "missing.so".to_owned(),
                loader: Some("upgradeable".to_owned()),
            }],
            ..Default::default()
        };

        let error = apply_bootstrap(&mut world, &bootstrap, ".")
            .unwrap_err()
            .to_string();

        assert!(error.contains("unsupported sim.programs loader"));
    }

    #[test]
    fn manifest_rejects_unavailable_evidence_flags() {
        let mut world = World::default();
        let bootstrap = SimBootstrap {
            metrics: MetricsConfig {
                enabled: true,
                filename: Some("artifacts/guided-sim-metrics.json".to_owned()),
            },
            ..Default::default()
        };

        let error = apply_bootstrap(&mut world, &bootstrap, ".")
            .unwrap_err()
            .to_string();

        assert!(error.contains("sim.metrics.enabled is declared"));
    }

    #[test]
    fn cached_fork_does_not_refetch_without_overwrite() {
        let root = unique_temp_dir();
        fs::create_dir_all(&root).unwrap();
        let address = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let cache = root.join("cache.json");
        write_account_snapshot(
            &address,
            &Account {
                lamports: 7,
                data: vec![9],
                owner,
                executable: false,
                rent_epoch: 0,
            },
            &cache,
        )
        .unwrap();

        let account = load_or_fetch_account(&address, "http://127.0.0.1:9", &cache, false).unwrap();

        assert_eq!(account.lamports, 7);
        assert_eq!(account.owner, owner);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cached_snapshot_pubkey_mismatch_fails() {
        let root = unique_temp_dir();
        fs::create_dir_all(&root).unwrap();
        let requested = Pubkey::new_unique();
        let cached = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let cache = root.join("cache.json");
        write_account_snapshot(
            &cached,
            &Account {
                lamports: 1,
                data: vec![],
                owner,
                executable: false,
                rent_epoch: 0,
            },
            &cache,
        )
        .unwrap();

        let error = load_or_fetch_account(&requested, "http://127.0.0.1:9", &cache, false)
            .unwrap_err()
            .to_string();

        assert!(error.contains("does not match manifest address"));

        let _ = fs::remove_dir_all(root);
    }

    fn unique_temp_dir() -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("riptide-sim-bootstrap-{nanos}"))
    }
}
