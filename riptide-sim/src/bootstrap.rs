// Adapted from Trident (MIT) — https://github.com/Ackee-Blockchain/trident

use std::{
    fs,
    path::{Path, PathBuf},
    str::FromStr,
    time::Duration,
};

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_loader_v3_interface::state::UpgradeableLoaderState;
use solana_sdk::pubkey::Pubkey;

use crate::World;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BootstrapReport {
    pub programs_loaded: usize,
    pub accounts_loaded: usize,
    pub accounts_forked: usize,
    pub forked_snapshots: Vec<ForkSnapshotReport>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ForkSnapshotReport {
    pub address: Pubkey,
    pub owner: Pubkey,
    pub executable: bool,
    pub data_hash: String,
    pub cluster: String,
    pub filename: PathBuf,
    pub fetched_slot: Option<u64>,
    pub loader_type: String,
    pub paired_programdata_address: Option<Pubkey>,
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
    /// Risk-surface parameter sweep. Consumed by the runner via forwarded CLI
    /// flags (`riptide sim run` reads it here and passes `--sweep`); bootstrap
    /// ignores it, but it must be declared so `deny_unknown_fields` accepts a
    /// sweep manifest.
    #[serde(default)]
    pub sweep: Option<SweepManifest>,
    /// Cartography metadata (class + risk objective) for the guided-sim →
    /// risk-surface producer. Read by `riptide sim surface`; bootstrap ignores
    /// it. Declared here so a cartography manifest parses cleanly.
    #[serde(default)]
    pub cartography: Option<CartographyManifest>,
    /// Execution-honesty positive control: the known-correct baseline sweep
    /// coordinate. Read by `riptide sim run`/`riptide sim surface`; bootstrap
    /// ignores it. Declared here so an honesty-bearing manifest parses cleanly.
    #[serde(default)]
    pub positive_control: Option<PositiveControlManifest>,
    /// Execution-honesty lifecycle declaration: transaction labels that must
    /// execute on-chain for the run to be honest evidence. Read by
    /// `riptide sim run`/`riptide sim surface`; bootstrap ignores it.
    #[serde(default)]
    pub lifecycle: Option<LifecycleManifest>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SweepManifest {
    pub name: String,
    pub values: Vec<f64>,
    #[serde(default = "default_seeds_per_value")]
    pub seeds_per_value: u64,
}

fn default_seeds_per_value() -> u64 {
    1
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CartographyManifest {
    pub class: String,
    pub risk_objective: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PositiveControlManifest {
    /// Swept axis the control coordinate lives on; defaults to the sweep name.
    pub parameter: Option<String>,
    pub value: f64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LifecycleManifest {
    pub required_flows: Vec<String>,
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

    world.configure_guided_artifacts(bootstrap.metrics.clone(), bootstrap.regression.clone());
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
        let (account, mut snapshot) = load_or_fetch_account_with_report(
            &address,
            &fork.cluster,
            &cache_path,
            fork.overwrite,
        )?;
        if let Some(programdata_address) =
            upgradeable_programdata_address(&account).with_context(|| {
                format!(
                    "forked account {address} is owned by the upgradeable loader but its program state could not be decoded"
                )
            })?
        {
            let programdata_cache_path =
                paired_programdata_cache_path(&cache_path, &programdata_address);
            let (programdata_account, programdata_snapshot) = load_or_fetch_account_with_report(
                &programdata_address,
                &fork.cluster,
                &programdata_cache_path,
                fork.overwrite,
            )
            .with_context(|| {
                format!(
                    "forked upgradeable program {address} references program-data account {programdata_address}; cache it locally or use a direct local .so fallback"
                )
            })?;
            world.set_account(programdata_address, programdata_account)?;
            snapshot.paired_programdata_address = Some(programdata_address);
            report.accounts_forked += 1;
            report.forked_snapshots.push(programdata_snapshot);
        }
        world.set_account(address, account)?;
        report.accounts_forked += 1;
        report.forked_snapshots.push(snapshot);
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
    write_account_snapshot_with_provenance(pubkey, account, path, None, None)
}

pub fn write_account_snapshot_with_provenance(
    pubkey: &Pubkey,
    account: &Account,
    path: impl AsRef<Path>,
    cluster: Option<&str>,
    fetched_slot: Option<u64>,
) -> Result<()> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("create account snapshot dir {}", parent.display()))?;
    }
    let mut value = json!({
        "pubkey": pubkey.to_string(),
        "account": {
            "lamports": account.lamports,
            "data": [BASE64.encode(&account.data), "base64"],
            "owner": account.owner.to_string(),
            "executable": account.executable,
            "rentEpoch": account.rent_epoch,
        }
    });
    if let Some(cluster) = cluster {
        value["provenance"] = json!({
            "address": pubkey.to_string(),
            "cluster": cluster,
            "fetched_slot": fetched_slot,
            "owner": account.owner.to_string(),
            "executable": account.executable,
            "data_hash": account_data_hash(account),
            "filename": path.display().to_string(),
        });
    }
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
    load_or_fetch_account_with_report(address, cluster, cache_path, overwrite)
        .map(|(account, _)| account)
}

pub fn load_or_fetch_account_with_report(
    address: &Pubkey,
    cluster: &str,
    cache_path: impl AsRef<Path>,
    overwrite: bool,
) -> Result<(Account, ForkSnapshotReport)> {
    let cache_path = cache_path.as_ref();
    if cache_path.exists() && !overwrite {
        let account = read_account_snapshot_for_pubkey(cache_path, address)?;
        let report = fork_snapshot_report(address, &account, cluster, cache_path, None)?;
        return Ok((account, report));
    }

    let fetched = fetch_account_with_context(address, cluster)?;
    write_account_snapshot_with_provenance(
        address,
        &fetched.account,
        cache_path,
        Some(cluster),
        fetched.slot,
    )?;
    let report =
        fork_snapshot_report(address, &fetched.account, cluster, cache_path, fetched.slot)?;
    Ok((fetched.account, report))
}

#[derive(Debug, Clone)]
pub struct FetchedAccount {
    pub account: Account,
    pub slot: Option<u64>,
}

pub fn fetch_account(address: &Pubkey, cluster: &str) -> Result<Account> {
    fetch_account_with_context(address, cluster).map(|fetched| fetched.account)
}

pub fn fetch_account_with_context(address: &Pubkey, cluster: &str) -> Result<FetchedAccount> {
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
    let slot = response
        .pointer("/result/context/slot")
        .and_then(Value::as_u64);
    Ok(FetchedAccount {
        account: parse_account_value(value)?,
        slot,
    })
}

pub fn account_data_hash(account: &Account) -> String {
    sha256_hex(&account.data)
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

fn paired_programdata_cache_path(
    program_cache_path: &Path,
    programdata_address: &Pubkey,
) -> PathBuf {
    program_cache_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!("{programdata_address}.json"))
}

fn fork_snapshot_report(
    address: &Pubkey,
    account: &Account,
    cluster: &str,
    filename: &Path,
    fetched_slot: Option<u64>,
) -> Result<ForkSnapshotReport> {
    Ok(ForkSnapshotReport {
        address: *address,
        owner: account.owner,
        executable: account.executable,
        data_hash: account_data_hash(account),
        cluster: cluster.to_owned(),
        filename: filename.to_path_buf(),
        fetched_slot,
        loader_type: loader_type(account)?,
        paired_programdata_address: None,
    })
}

fn loader_type(account: &Account) -> Result<String> {
    if account.owner != upgradeable_loader_id() {
        return Ok(if account.executable {
            "executable-account".to_owned()
        } else {
            "account".to_owned()
        });
    }
    let state: UpgradeableLoaderState =
        bincode::deserialize(&account.data).context("decode upgradeable loader account state")?;
    Ok(match state {
        UpgradeableLoaderState::Uninitialized => "upgradeable-uninitialized",
        UpgradeableLoaderState::Buffer { .. } => "upgradeable-buffer",
        UpgradeableLoaderState::Program { .. } => "upgradeable-program",
        UpgradeableLoaderState::ProgramData { .. } => "upgradeable-program-data",
    }
    .to_owned())
}

fn upgradeable_programdata_address(account: &Account) -> Result<Option<Pubkey>> {
    if account.owner != upgradeable_loader_id() || !account.executable {
        return Ok(None);
    }
    let state: UpgradeableLoaderState =
        bincode::deserialize(&account.data).context("decode upgradeable loader program account")?;
    match state {
        UpgradeableLoaderState::Program {
            programdata_address,
        } => Ok(Some(programdata_address)),
        other => bail!("expected upgradeable Program account, got {other:?}"),
    }
}

fn upgradeable_loader_id() -> Pubkey {
    Pubkey::from_str("BPFLoaderUpgradeab1e11111111111111111111111")
        .expect("upgradeable loader id is valid")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("{digest:x}")
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
    fn manifest_accepts_execution_honesty_sections() {
        let manifest: SimManifest = toml::from_str(
            r#"
[sim.sweep]
name = "rate_shock_bps"
values = [0, 100, 200]
seeds_per_value = 4

[sim.positive_control]
value = 0

[sim.lifecycle]
required_flows = ["deposit_liquidity", "open_swap"]
"#,
        )
        .unwrap();

        let control = manifest.sim.positive_control.unwrap();
        assert_eq!(control.parameter, None);
        assert_eq!(control.value, 0.0);
        let lifecycle = manifest.sim.lifecycle.unwrap();
        assert_eq!(
            lifecycle.required_flows,
            vec!["deposit_liquidity", "open_swap"]
        );
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
    fn manifest_rejects_unavailable_coverage_flag() {
        let mut world = World::default();
        let bootstrap = SimBootstrap {
            coverage: CoverageConfig { enabled: true },
            ..Default::default()
        };

        let error = apply_bootstrap(&mut world, &bootstrap, ".")
            .unwrap_err()
            .to_string();

        assert!(error.contains("sim.coverage.enabled is declared"));
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

    #[test]
    fn snapshot_provenance_records_hash_and_source() {
        let root = unique_temp_dir();
        fs::create_dir_all(&root).unwrap();
        let address = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let cache = root.join("cache.json");
        let account = Account {
            lamports: 99,
            data: vec![1, 2, 3, 4],
            owner,
            executable: false,
            rent_epoch: 0,
        };

        write_account_snapshot_with_provenance(
            &address,
            &account,
            &cache,
            Some("devnet"),
            Some(123),
        )
        .unwrap();

        let raw = fs::read_to_string(&cache).unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            value.pointer("/provenance/address").unwrap(),
            &json!(address.to_string())
        );
        assert_eq!(
            value.pointer("/provenance/cluster").unwrap(),
            &json!("devnet")
        );
        assert_eq!(
            value.pointer("/provenance/fetched_slot").unwrap(),
            &json!(123)
        );
        assert_eq!(
            value.pointer("/provenance/data_hash").unwrap(),
            &json!(account_data_hash(&account))
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cached_upgradeable_program_forks_programdata_pair() {
        let root = unique_temp_dir();
        fs::create_dir_all(&root).unwrap();
        let source_world = World::default();
        let program = parse_pubkey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb").unwrap();
        let program_account = source_world.get_account(&program).unwrap();
        let programdata = upgradeable_programdata_address(&program_account)
            .unwrap()
            .unwrap();
        let programdata_account = source_world.get_account(&programdata).unwrap();
        let program_cache = root.join("program.json");
        let programdata_cache = root.join(format!("{programdata}.json"));
        write_account_snapshot(&program, &program_account, &program_cache).unwrap();
        write_account_snapshot(&programdata, &programdata_account, &programdata_cache).unwrap();
        fs::write(
            root.join("Riptide.toml"),
            format!(
                "[[sim.fork]]\naddress = \"{}\"\ncluster = \"http://127.0.0.1:9\"\nfilename = \"program.json\"\noverwrite = false\n",
                program
            ),
        )
        .unwrap();

        let mut world = World::default();
        let report = apply_manifest(&mut world, root.join("Riptide.toml")).unwrap();

        assert!(world.get_account(&program).unwrap().executable);
        assert!(world.get_account(&programdata).is_some());
        assert_eq!(report.accounts_forked, 2);
        assert!(report
            .forked_snapshots
            .iter()
            .any(|snapshot| snapshot.loader_type == "upgradeable-program"
                && snapshot.paired_programdata_address == Some(programdata)));
        assert!(report
            .forked_snapshots
            .iter()
            .any(|snapshot| snapshot.loader_type == "upgradeable-program-data"));

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
