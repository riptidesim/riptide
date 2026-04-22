//! Reviewer-ready evidence pack emission.
//!
//! Every `riptide run` and `riptide replay` writes a pack under
//! `.riptide/pack/<run-id>/` carrying the shape reviewers forward
//! cold: executive summary, reviewer-grade technical trace, a
//! verbatim rerun recipe, and a machine-readable manifest that
//! indexes back into the run-config + adapter + simulation-result
//! artifacts by repo-relative path.
//!
//! The pack is deterministic: given byte-identical `SimulationResult`
//! input it produces byte-identical files. No timestamps, no random
//! state, no environment lookups. Absolute paths, hostnames, and
//! ephemeral tmp paths never land in any pack artifact — every path
//! is normalized against the configured `repo_root` and only emitted
//! when the normalized form is a clean, safe, repo-relative string.

pub mod render;

use std::{
    collections::BTreeMap,
    fs,
    io::Write as _,
    path::{Path, PathBuf},
};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::types::SimulationResult;

pub use render::{render_summary_md, render_trace_md};

/// The inputs a single run consumed, captured as repo-anchored
/// references so the pack can point a reviewer at every file the
/// run actually read from disk. None of these paths is load-bearing
/// for the pack's byte-stability — callers that do not know a given
/// path (e.g. bare `riptide-engine` without an adapter) leave it
/// `None`, and the manifest simply omits that key.
#[derive(Debug, Clone, Default)]
pub struct PackInputs {
    /// Adapter TOML the engine loaded for this run. `None` for runs
    /// that fell through the no-adapter lending default, or for the
    /// multi-component path which uses a list of adapters instead.
    pub adapter: Option<PathBuf>,
    /// Run-config JSON (`riptide run`) or replay-config JSON
    /// (`riptide replay`). `None` when the CLI synthesized a config
    /// in a tmp directory with no on-disk canonical home (in that
    /// case the caller MUST NOT pass the tmp path; it should pass
    /// `None` and the manifest omits the key).
    pub config: Option<PathBuf>,
    /// Policies file (for `riptide run` with a pre-compiled bundle).
    pub policies: Option<PathBuf>,
    /// Trajectory directories keyed by component name. Single-
    /// component replays push a single `("", dir)` entry. Multi-
    /// component replays push one entry per component.
    pub trajectory_dirs: Vec<(String, PathBuf)>,
    /// Per-component adapter TOMLs for multi-component replays, keyed
    /// by component name. Empty for single-component paths (where
    /// `adapter` above already carries the lone adapter).
    pub component_adapters: Vec<(String, PathBuf)>,
}

/// The outputs the engine already wrote or plans to write, captured
/// as repo-anchored references. Mirrors `PackInputs`.
#[derive(Debug, Clone, Default)]
pub struct PackOutputs {
    /// Absolute path (before normalization) to the
    /// `simulation-result.json` the engine just wrote.
    pub simulation_result: Option<PathBuf>,
    /// Absolute path to `.riptide/last-run.json` when the CLI run
    /// loop produced one (multi-scenario sweeps); `None` for bare
    /// engine invocations and single-replay CLI runs.
    pub last_run: Option<PathBuf>,
}

/// One-shot options for `emit_pack`.
#[derive(Debug, Clone)]
pub struct PackEmitOptions {
    /// Repository root the pack normalizes paths against. All input
    /// and output paths surfaced in the pack are expressed relative
    /// to this root; any path that escapes the root (e.g. `/tmp`,
    /// `$HOME`) is rejected and must be supplied as `None` instead.
    pub repo_root: PathBuf,
    /// Directory the pack itself lives under. Typically
    /// `<repo_root>/.riptide/pack/<run-id>/`. Created (with any
    /// missing parents) before emission.
    pub pack_dir: PathBuf,
    /// Optional override for the reviewer-facing command in
    /// `rerun.sh`. CLI callers pass the high-level form
    /// (`riptide replay <config>`); bare engine callers let this
    /// default to a `riptide-engine ...` invocation derived from the
    /// inputs.
    pub command_hint: Option<String>,
    /// Optional override for the manifest-declared adapter display
    /// name. When `None`, derived from `inputs.adapter` or the list
    /// of component adapters.
    pub adapter_display: Option<String>,
}

/// What `emit_pack` returns to the caller. Callers surface `pack_dir`
/// on stderr so the reviewer sees exactly where the forwardable
/// artifact landed.
#[derive(Debug, Clone)]
pub struct PackEmission {
    pub pack_dir: PathBuf,
    pub manifest_path: PathBuf,
    pub summary_path: PathBuf,
    pub trace_path: PathBuf,
    pub rerun_path: PathBuf,
    pub canonical_hash: String,
    pub run_id: String,
}

/// Compute the canonical SHA256 of a `SimulationResult` using the
/// same "replace output_path with __canonical__" normalization the
/// Sprint 11 contagion fixture pins. Exposed so CLI / test callers
/// can re-derive the hash without going through `emit_pack`.
pub fn canonical_hash(result: &SimulationResult) -> String {
    let mut canonical = result.clone();
    canonical.run_config.output_path = "__canonical__".to_string();
    let bytes =
        serde_json::to_vec(&canonical).expect("SimulationResult is always JSON-serializable");
    let digest = Sha256::digest(&bytes);
    format!("{digest:x}")
}

/// Sanitize a scenario string into a filesystem-safe run-id slug.
/// Deterministic: same scenario always yields the same slug so a
/// rerun lands on top of the prior pack and the byte-stability test
/// can target a pinned path.
pub fn derive_run_id(scenario: &str) -> String {
    let mut out = String::with_capacity(scenario.len());
    let mut last_was_dash = false;
    for ch in scenario.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_was_dash = false;
        } else if !last_was_dash {
            out.push('-');
            last_was_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "run".into()
    } else {
        trimmed
    }
}

/// Normalize an absolute or cwd-relative path into a repo-relative
/// string. Returns `None` when the path escapes the repo root —
/// callers omit that path from the manifest rather than leak an
/// absolute path into a pack.
pub fn to_repo_relative(root: &Path, target: &Path) -> Option<String> {
    let abs_root = fs::canonicalize(root).ok().unwrap_or_else(|| root.to_path_buf());
    let abs_target = if target.is_absolute() {
        fs::canonicalize(target).ok().unwrap_or_else(|| target.to_path_buf())
    } else {
        let joined = abs_root.join(target);
        fs::canonicalize(&joined).unwrap_or(joined)
    };
    let rel = abs_target.strip_prefix(&abs_root).ok()?;
    if rel.as_os_str().is_empty() {
        return Some(".".into());
    }
    let mut s = rel.to_string_lossy().into_owned();
    // POSIX-shape: forward slashes regardless of host platform so the
    // pack is byte-stable across macOS / Linux / CI runners.
    if std::path::MAIN_SEPARATOR != '/' {
        s = s.replace(std::path::MAIN_SEPARATOR, "/");
    }
    Some(s)
}

/// Emit the reviewer-ready evidence pack for a single
/// `SimulationResult`. Writes `summary.md`, `trace.md`,
/// `manifest.json`, `rerun.sh`, `inputs/paths.json`, and
/// `outputs/paths.json` under `options.pack_dir`.
pub fn emit_pack(
    result: &SimulationResult,
    inputs: &PackInputs,
    outputs: &PackOutputs,
    options: &PackEmitOptions,
) -> Result<PackEmission> {
    fs::create_dir_all(&options.pack_dir).with_context(|| {
        format!("create pack dir at {}", options.pack_dir.display())
    })?;
    fs::create_dir_all(options.pack_dir.join("inputs"))?;
    fs::create_dir_all(options.pack_dir.join("outputs"))?;

    let run_id = derive_run_id(&result.run_config.scenario);
    let hash = canonical_hash(result);

    let input_rel = normalize_inputs(&options.repo_root, inputs);
    let output_rel = normalize_outputs(&options.repo_root, outputs);

    let manifest = build_manifest(
        result,
        &run_id,
        &hash,
        &input_rel,
        &output_rel,
        options.adapter_display.as_deref(),
    );
    let manifest_path = options.pack_dir.join("manifest.json");
    let manifest_json = serde_json::to_string_pretty(&manifest)?;
    write_atomic(&manifest_path, &manifest_json)?;
    // trailing newline — consistent with write_result in main.rs.
    append_newline(&manifest_path)?;

    let summary_md = render::render_summary_md(result, &manifest);
    let summary_path = options.pack_dir.join("summary.md");
    write_atomic(&summary_path, &summary_md)?;

    let trace_md = render::render_trace_md(result, &manifest);
    let trace_path = options.pack_dir.join("trace.md");
    write_atomic(&trace_path, &trace_md)?;

    // Inputs / outputs subdir manifests. Repo-relative paths only —
    // the `paths.json` files are the reviewer's authoritative pointer
    // back to the real artifacts without any copy duplication.
    write_atomic(
        &options.pack_dir.join("inputs/paths.json"),
        &serde_json::to_string_pretty(&input_rel.as_manifest())?,
    )?;
    append_newline(&options.pack_dir.join("inputs/paths.json"))?;
    write_atomic(
        &options.pack_dir.join("outputs/paths.json"),
        &serde_json::to_string_pretty(&output_rel.as_manifest())?,
    )?;
    append_newline(&options.pack_dir.join("outputs/paths.json"))?;

    let rerun_sh = render::render_rerun_sh(
        result,
        &input_rel,
        &output_rel,
        options.command_hint.as_deref(),
    );
    let rerun_path = options.pack_dir.join("rerun.sh");
    write_atomic(&rerun_path, &rerun_sh)?;
    make_executable(&rerun_path).ok();

    // Absolute-path / hostname / shell-injection scan as a load-
    // bearing defensive check. If any pack artifact has leaked an
    // absolute path, user-identifying string, or shell meta-
    // character pattern, scrub the partial pack from disk and
    // fail emission so the caller sees the leak loudly instead of
    // a partially-written directory the next retry would find.
    if let Err(err) = scan_pack_for_leaks(&options.pack_dir) {
        // Best-effort scrub. Failure to scrub is not fatal — the
        // emission error is what the caller cares about, and the
        // partial files were about to be diagnosed anyway.
        let _ = fs::remove_dir_all(&options.pack_dir);
        return Err(err);
    }

    Ok(PackEmission {
        pack_dir: options.pack_dir.clone(),
        manifest_path,
        summary_path,
        trace_path,
        rerun_path,
        canonical_hash: hash,
        run_id,
    })
}

/// Structured inputs ready for serialization into the pack. All paths
/// are repo-relative POSIX strings; an absent entry is `None` and
/// omitted from the emitted JSON. Exposed to `render::` helpers.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PackInputsRel {
    pub adapter: Option<String>,
    pub config: Option<String>,
    pub policies: Option<String>,
    pub trajectory_dirs: BTreeMap<String, String>,
    pub component_adapters: BTreeMap<String, String>,
}

impl PackInputsRel {
    fn as_manifest(&self) -> Value {
        let mut obj = serde_json::Map::new();
        if let Some(p) = &self.adapter {
            obj.insert("adapter".into(), json!(p));
        }
        if let Some(p) = &self.config {
            obj.insert("config".into(), json!(p));
        }
        if let Some(p) = &self.policies {
            obj.insert("policies".into(), json!(p));
        }
        if !self.trajectory_dirs.is_empty() {
            obj.insert("trajectory_dirs".into(), json!(self.trajectory_dirs));
        }
        if !self.component_adapters.is_empty() {
            obj.insert("component_adapters".into(), json!(self.component_adapters));
        }
        Value::Object(obj)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PackOutputsRel {
    pub simulation_result: Option<String>,
    pub last_run: Option<String>,
}

impl PackOutputsRel {
    fn as_manifest(&self) -> Value {
        let mut obj = serde_json::Map::new();
        if let Some(p) = &self.simulation_result {
            obj.insert("simulation_result".into(), json!(p));
        }
        if let Some(p) = &self.last_run {
            obj.insert("last_run".into(), json!(p));
        }
        Value::Object(obj)
    }
}

fn normalize_inputs(root: &Path, inputs: &PackInputs) -> PackInputsRel {
    let mut out = PackInputsRel::default();
    out.adapter = inputs
        .adapter
        .as_ref()
        .and_then(|p| to_repo_relative(root, p));
    out.config = inputs.config.as_ref().and_then(|p| to_repo_relative(root, p));
    out.policies = inputs
        .policies
        .as_ref()
        .and_then(|p| to_repo_relative(root, p));
    for (name, path) in &inputs.trajectory_dirs {
        if let Some(rel) = to_repo_relative(root, path) {
            out.trajectory_dirs.insert(name.clone(), rel);
        }
    }
    for (name, path) in &inputs.component_adapters {
        if let Some(rel) = to_repo_relative(root, path) {
            out.component_adapters.insert(name.clone(), rel);
        }
    }
    out
}

fn normalize_outputs(root: &Path, outputs: &PackOutputs) -> PackOutputsRel {
    PackOutputsRel {
        simulation_result: outputs
            .simulation_result
            .as_ref()
            .and_then(|p| to_repo_relative(root, p)),
        last_run: outputs.last_run.as_ref().and_then(|p| to_repo_relative(root, p)),
    }
}

/// Machine-readable pack manifest. Fields are stable across Sprint 12;
/// additive-only changes require bumping `schema_version`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackManifest {
    pub schema_version: u32,
    pub kind: String,
    pub run_id: String,
    pub scenario: String,
    pub adapter: Option<String>,
    pub component_adapters: BTreeMap<String, String>,
    pub total_ticks: u32,
    pub agents: u32,
    pub event_count: usize,
    pub canonical_hash: String,
    pub invariant_firings: Vec<InvariantFiringRow>,
    pub exit_code: u32,
    pub inputs: PackInputsRel,
    pub outputs: PackOutputsRel,
    pub simulation_boundaries: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvariantFiringRow {
    pub name: String,
    pub firings: u64,
    pub first_tick: Option<u32>,
    pub field: Option<String>,
    pub op: Option<String>,
    pub value: Option<f64>,
}

fn build_manifest(
    result: &SimulationResult,
    run_id: &str,
    hash: &str,
    inputs: &PackInputsRel,
    outputs: &PackOutputsRel,
    adapter_display: Option<&str>,
) -> PackManifest {
    let kind = if result.run_config.scenario.starts_with("replay:multi:") {
        "replay-multi".to_string()
    } else if result.run_config.scenario.starts_with("replay:") {
        "replay".to_string()
    } else {
        "simulation-run".to_string()
    };

    let adapter_name = adapter_display
        .map(|s| s.to_string())
        .or_else(|| inputs.adapter.clone())
        .or_else(|| {
            if !inputs.component_adapters.is_empty() {
                Some(
                    inputs
                        .component_adapters
                        .values()
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(", "),
                )
            } else {
                None
            }
        });

    let firings = collect_invariant_firings(result);
    let total_firings: u64 = firings.iter().map(|r| r.firings).sum();
    let exit_code = if total_firings > 0 { 1 } else { 0 };

    PackManifest {
        schema_version: 1,
        kind,
        run_id: run_id.to_string(),
        scenario: result.run_config.scenario.clone(),
        adapter: adapter_name,
        component_adapters: inputs.component_adapters.clone(),
        total_ticks: result.total_ticks,
        agents: result.run_config.agents,
        event_count: result.events.len(),
        canonical_hash: hash.to_string(),
        invariant_firings: firings,
        exit_code,
        inputs: inputs.clone(),
        outputs: outputs.clone(),
        simulation_boundaries: result.simulation_boundaries.clone(),
    }
}

fn collect_invariant_firings(result: &SimulationResult) -> Vec<InvariantFiringRow> {
    let rollup = match result.summary.get("invariants_fired").and_then(|v| v.as_array()) {
        Some(arr) => arr,
        None => return Vec::new(),
    };
    let mut first_ticks: BTreeMap<String, u32> = BTreeMap::new();
    for event in &result.events {
        if let Some(name) = event.action.strip_prefix("invariant_violation:") {
            first_ticks.entry(name.to_string()).or_insert(event.tick);
        }
    }
    rollup
        .iter()
        .map(|row| {
            let name = row.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let firings = row.get("firings").and_then(|v| v.as_u64()).unwrap_or(0);
            let first_tick = first_ticks.get(&name).copied();
            InvariantFiringRow {
                field: row.get("field").and_then(|v| v.as_str()).map(str::to_string),
                op: row.get("op").and_then(|v| v.as_str()).map(str::to_string),
                value: row.get("value").and_then(|v| v.as_f64()),
                name,
                firings,
                first_tick,
            }
        })
        .collect()
}

fn write_atomic(path: &Path, body: &str) -> Result<()> {
    let tmp = path.with_extension("pack-tmp");
    {
        let mut f = fs::File::create(&tmp)
            .with_context(|| format!("create {}", tmp.display()))?;
        f.write_all(body.as_bytes())?;
    }
    fs::rename(&tmp, path)
        .with_context(|| format!("rename into {}", path.display()))?;
    Ok(())
}

fn append_newline(path: &Path) -> Result<()> {
    let mut file = fs::OpenOptions::new().append(true).open(path)?;
    let meta = fs::metadata(path)?;
    if meta.len() == 0 {
        return Ok(());
    }
    let body = fs::read(path)?;
    if body.last().copied() != Some(b'\n') {
        file.write_all(b"\n")?;
    }
    Ok(())
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(path)?.permissions();
    perms.set_mode(0o755);
    fs::set_permissions(path, perms)?;
    Ok(())
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<()> {
    Ok(())
}

/// Scan every file in the emitted pack for patterns that would break
/// the forwardability promise: absolute host paths, `$HOME`-prefixed
/// paths, POSIX tmp prefixes, macOS `/var/folders/` tmp prefixes,
/// and — inside `rerun.sh` specifically — shell metacharacter
/// patterns that would let a forwarded pack execute code on the
/// reviewer's machine. Each find fails emission so the caller sees
/// the leak loudly rather than shipping a poisoned pack.
///
/// The path-shape scan is intentionally narrow — it matches absolute-
/// path shapes that cannot be reviewer-portable, not every substring
/// that happens to include `$USER`. A username like `ci` or `test`
/// would false-positive on any run-config field ending in `-ci` or
/// `-test`.
///
/// The rerun.sh-specific scan is a belt-and-braces guard on top of
/// the single-quote wrapping in `render::render_rerun_sh`: even if
/// a future renderer change forgets to quote something, any of
/// `$(`, backtick, or `${` landing inside the emitted script blocks
/// emission. See F-2026-04-21-S12P1-001 for the shell-injection
/// finding this catches.
fn scan_pack_for_leaks(pack_dir: &Path) -> Result<()> {
    let hostname = std::env::var("HOSTNAME").ok();
    let home = std::env::var("HOME").ok();
    for entry in walk_files(pack_dir) {
        let rel = entry.strip_prefix(pack_dir).unwrap_or(&entry).to_path_buf();
        let body = match fs::read_to_string(&entry) {
            Ok(s) => s,
            Err(_) => continue,
        };
        if body.contains("/home/") {
            bail!(
                "pack leak: absolute /home/ path in {} — emission rejected",
                rel.display()
            );
        }
        if body.contains("/Users/") {
            bail!(
                "pack leak: absolute /Users/ path in {} — emission rejected",
                rel.display()
            );
        }
        if body.contains("/tmp/") {
            bail!(
                "pack leak: /tmp/ path in {} — emission rejected",
                rel.display()
            );
        }
        if body.contains("/var/folders/") {
            bail!(
                "pack leak: macOS /var/folders/ tmp path in {} — emission rejected",
                rel.display()
            );
        }
        if let Some(host) = hostname.as_deref() {
            // Only match $HOSTNAME as a hostname-shaped substring (at
            // least 4 chars, contains a dot or dash). Short matches
            // overlap too heavily with legitimate run-config / scenario
            // tokens.
            if host.len() >= 4
                && (host.contains('.') || host.contains('-'))
                && body.contains(host)
            {
                bail!(
                    "pack leak: $HOSTNAME ({}) appears in {} — emission rejected",
                    host,
                    rel.display()
                );
            }
        }
        if let Some(home) = home.as_deref() {
            if !home.is_empty() && body.contains(home) {
                bail!(
                    "pack leak: $HOME ({}) appears in {} — emission rejected",
                    home,
                    rel.display()
                );
            }
        }
        if rel
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name == "rerun.sh")
            .unwrap_or(false)
        {
            scan_rerun_sh_for_injection(&rel, &body)?;
        }
    }
    Ok(())
}

/// Reject shell-metacharacter patterns in `rerun.sh` that a forwarded
/// pack could weaponize. Complements the single-quote wrapping in
/// `render::posix_single_quote`: even a bug that slipped an unquoted
/// path past the renderer gets caught here before the pack lands on
/// disk.
///
/// The scan walks the script line-by-line, ignores comment bodies
/// (leading `#`), and permits the small set of expansions the
/// renderer writes verbatim: `$(dirname "$0")` and `$0` appear in
/// the fixed prelude that `cd`s to the repo root and are intentional,
/// so we match against the exact emitted strings and ignore those
/// occurrences.
fn scan_rerun_sh_for_injection(rel: &Path, body: &str) -> Result<()> {
    const ALLOWED_EXPANSIONS: &[&str] = &[
        // rerun.sh header prelude — known-safe, emitted as literal.
        "here=$(cd \"$(dirname \"$0\")\" && pwd)",
    ];
    for (lineno, raw) in body.lines().enumerate() {
        let trimmed = raw.trim_start();
        if trimmed.starts_with('#') {
            continue;
        }
        // Strip allowed expansions first so the scan doesn't false-
        // positive on the renderer's own prelude.
        let mut sanitized = raw.to_string();
        for allowed in ALLOWED_EXPANSIONS {
            sanitized = sanitized.replace(allowed, "");
        }
        for (needle, label) in &[
            ("$(", "command substitution `$(`"),
            ("`", "backtick command substitution"),
            ("${", "parameter expansion `${`"),
            ("$\"", "locale-aware quoted string"),
        ] {
            if sanitized.contains(needle) {
                bail!(
                    "pack leak: {label} on line {} of {} — shell-injection risk, emission rejected",
                    lineno + 1,
                    rel.display()
                );
            }
        }
    }
    Ok(())
}

fn walk_files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(root) {
        for entry in rd.flatten() {
            let path = entry.path();
            if path.is_dir() {
                out.extend(walk_files(&path));
            } else {
                out.push(path);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_id_sanitizes_replay_multi_scenarios() {
        assert_eq!(
            derive_run_id("replay:multi:lst-lending-contagion-proof-upstream"),
            "replay-multi-lst-lending-contagion-proof-upstream"
        );
        assert_eq!(derive_run_id("baseline"), "baseline");
        assert_eq!(derive_run_id("price_shock"), "price-shock");
        assert_eq!(derive_run_id("::::"), "run");
        assert_eq!(
            derive_run_id("replay:lending-whale-bad-debt"),
            "replay-lending-whale-bad-debt"
        );
    }
}
