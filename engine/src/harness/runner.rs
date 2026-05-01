//! Compile-time linked runner for project harness crates.
//!
//! Generated harness crates call [`run_harness_cli`] from their `main`.
//! That keeps the runtime model Rust-first without relying on unstable
//! dynamic plugin ABIs.

use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    process::ExitCode,
};

use anyhow::Result;
use clap::Parser;

use crate::{
    adapter::{load_adapter, Adapter, Protocol},
    harness::plugin::{HarnessContext, RiptideHarness},
    primitive::{
        build_generic_policies, generic_runtime_actions, GenericBootstrapConfig, GenericHarness,
    },
    replay::{import_replay_state, load_state_pack, ReplayStateImport, StatePackImport},
    scenario::{
        load_presets_dir, BaselineScenario, PresetSpec, PriceShockScenario, Scenario, ScenarioKind,
    },
    sim::{build_agent_personas, run_generic_simulation, SimulationParams},
    types::{Policy, RunConfig, SimulationResult},
};

#[derive(Debug, Parser)]
#[command(
    name = "riptide-harness",
    version,
    about = "Run a Riptide simulation with a project-owned Rust harness"
)]
struct HarnessCli {
    #[arg(long, value_name = "FILE")]
    config: PathBuf,
    #[arg(long, value_name = "FILE")]
    policies: PathBuf,
    #[arg(long, value_name = "FILE")]
    output: PathBuf,
    #[arg(long, value_name = "FILE")]
    adapter: PathBuf,
    #[arg(long, value_name = "DIR")]
    state_pack: Option<PathBuf>,
    #[arg(long, value_name = "FILE")]
    program_so: Option<PathBuf>,
    #[arg(long, default_value_t = false)]
    allow_invariant_violations: bool,
}

#[derive(Debug, Clone)]
pub struct HarnessRunOptions {
    pub config: PathBuf,
    pub policies: PathBuf,
    pub adapter: PathBuf,
    pub state_pack: Option<PathBuf>,
    pub program_so: Option<PathBuf>,
}

enum HarnessOutcome {
    Clean,
    InvariantFired(u64),
}

impl HarnessOutcome {
    fn exit_code(&self, allow_invariant_violations: bool) -> ExitCode {
        match self {
            Self::Clean => ExitCode::SUCCESS,
            Self::InvariantFired(_) if allow_invariant_violations => ExitCode::SUCCESS,
            Self::InvariantFired(_) => ExitCode::FAILURE,
        }
    }
}

pub fn run_harness_cli<H>(harness: H) -> ExitCode
where
    H: RiptideHarness,
{
    let cli = HarnessCli::parse();
    match run_harness_command(&cli, harness) {
        Ok(outcome) => {
            if let HarnessOutcome::InvariantFired(count) = outcome {
                if cli.allow_invariant_violations {
                    eprintln!(
                        "riptide-harness: {count} invariant violation(s) recorded; \
                         --allow-invariant-violations restores exit 0"
                    );
                } else {
                    eprintln!(
                        "riptide-harness: {count} invariant violation(s); exiting 1. \
                         Pass --allow-invariant-violations to treat as exit 0."
                    );
                }
            }
            outcome.exit_code(cli.allow_invariant_violations)
        }
        Err(err) => {
            eprintln!("error: {err:#}");
            ExitCode::from(2)
        }
    }
}

fn run_harness_command<H>(cli: &HarnessCli, harness: H) -> Result<HarnessOutcome>
where
    H: RiptideHarness,
{
    let result = run_with_harness(
        HarnessRunOptions {
            config: cli.config.clone(),
            policies: cli.policies.clone(),
            adapter: cli.adapter.clone(),
            state_pack: cli.state_pack.clone(),
            program_so: cli.program_so.clone(),
        },
        harness,
    )?;
    write_result(&cli.output, &result)?;
    eprintln!("wrote {}", cli.output.display());

    let firing_count =
        count_invariant_firings(&result) + count_error_expression_invariant_firings(&result);
    if firing_count > 0 {
        Ok(HarnessOutcome::InvariantFired(firing_count))
    } else {
        Ok(HarnessOutcome::Clean)
    }
}

pub fn run_with_harness<H>(options: HarnessRunOptions, harness: H) -> Result<SimulationResult>
where
    H: RiptideHarness,
{
    let run_config: RunConfig = load_json(&options.config)?;
    let loaded_policies: Vec<Policy> = load_policies(&options.policies)?;
    let state_pack_import = load_current_state_pack(options.state_pack.as_ref(), &options.config)?;
    let adapter = load_adapter(&options.adapter).map_err(|e| anyhow::anyhow!("{e}"))?;
    if !matches!(adapter.runtime(), Protocol::Generic) {
        anyhow::bail!(
            "Rust project harnesses currently run against generic SBF/IDL adapters only; \
             {} resolved to {:?}",
            options.adapter.display(),
            adapter.runtime()
        );
    }
    if !loaded_policies.is_empty() {
        eprintln!(
            "warn: ignoring {} external policies from {} because the generic runtime uses inline adapter personas",
            loaded_policies.len(),
            options.policies.display()
        );
    }

    eprintln!(
        "riptide-harness: adapter={} agents={} ticks={} scenario={}",
        options.adapter.display(),
        run_config.agents,
        run_config.ticks,
        run_config.scenario,
    );
    if let Some(import) = state_pack_import.as_ref() {
        eprintln!(
            "state-pack: {} accounts from {}",
            import.accounts.len(),
            import.pack_path.display()
        );
        for warning in &import.warnings {
            eprintln!("warn: {warning}");
        }
    }

    let policies = build_generic_policies(&adapter, |warning| eprintln!("warn: {warning}"))
        .map_err(|e| anyhow::anyhow!("compile generic adapter personas: {e:#}"))?;
    let replay_import = load_adapter_replay_state(&adapter, Some(&options.adapter))?;
    let agent_personas =
        build_agent_personas(&run_config.personas, &policies, run_config.agents as usize)
            .map_err(|e| anyhow::anyhow!("{e}"))?;
    let program_so = options.program_so.unwrap_or_else(|| {
        PathBuf::from(
            adapter
                .program_so
                .as_deref()
                .expect("generic adapter validation requires program_so"),
        )
    });
    let idl_path = PathBuf::from(
        adapter
            .idl_path
            .as_deref()
            .expect("generic adapter validation requires idl_path"),
    );

    eprintln!("bootstrapping LiteSVM backend (generic + Rust harness) ...");
    let mut generic = GenericHarness::bootstrap(GenericBootstrapConfig {
        program_so,
        idl_path,
        agent_count: run_config.agents as usize,
        adapter: adapter.clone(),
    })
    .map_err(|e| anyhow::anyhow!("LiteSVM generic bootstrap failed: {e:#}"))?;
    apply_generic_replay_state(&mut generic, replay_import.as_ref())?;
    apply_generic_state_pack(&mut generic, state_pack_import.as_ref())?;

    {
        let mut ctx = HarnessContext::new(&mut generic);
        harness
            .setup(&mut ctx)
            .map_err(|e| anyhow::anyhow!("Rust harness setup failed: {e:#}"))?;
    }

    eprintln!(
        "LiteSVM ready: program={}, agents={}, runtime=generic+harness",
        generic.program_id,
        generic.agents.len(),
    );

    let mut scenario = build_scenario(&run_config)?;
    let params = SimulationParams {
        run_config: &run_config,
        policies,
        agent_personas,
        available_actions: generic_runtime_actions(&adapter),
        starting_balance: std::env::var("RIPTIDE_STARTING_BALANCE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(20_000.0),
        starting_price: 100.0,
        simulation_boundaries: simulation_boundaries_with_state_pack(
            vec![
                "In-process LiteSVM backend (no external validator).".into(),
                "Generic adapters expose only adapter-defined actions/observations; no default TVL/health semantics are inferred.".into(),
                "Project Rust harness setup ran before tick 0; custom account bytes are developer-owned.".into(),
                "Custom actions do not mutate engine cash/PnL by default; only on-chain account observations are authoritative.".into(),
            ],
            state_pack_import.as_ref(),
        ),
        invariants: adapter.invariants.clone(),
        scheduled_actions: adapter.scheduled_actions.clone(),
        semantics: adapter.semantics.clone(),
        errors: adapter.errors.clone(),
    };

    eprintln!("running tick loop ...");
    let mut result = run_generic_simulation(&mut generic, scenario.as_mut(), params)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    result.replay_provenance = state_pack_import
        .as_ref()
        .map(|import| import.provenance.clone())
        .or_else(|| replay_import.map(|import| import.provenance));
    Ok(result)
}

fn build_scenario(run_config: &RunConfig) -> Result<Box<dyn Scenario>> {
    let presets_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("engine crate has a parent directory")
        .join("fixtures/scenarios/presets");
    let scenario_presets = load_presets_dir(&presets_dir)
        .map_err(|e| anyhow::anyhow!("load scenario presets: {e:#}"))?;
    let scenario: Box<dyn Scenario> = if run_config.scenario == "baseline" {
        Box::new(BaselineScenario::new(100.0, 25))
    } else if let Some(preset) = lookup_preset(&scenario_presets, &run_config.scenario) {
        match preset.kind {
            ScenarioKind::PriceShock => {
                let drop = std::env::var("RIPTIDE_PRICE_SHOCK_DROP")
                    .ok()
                    .and_then(|s| s.parse::<f64>().ok())
                    .filter(|v| (0.0..1.0).contains(v))
                    .unwrap_or(preset.drop_percent);
                let shock_tick = (run_config.ticks / preset.shock_tick_denominator.max(1)).max(1);
                Box::new(PriceShockScenario::new(
                    preset.base_price,
                    preset.noise_bps,
                    shock_tick,
                    drop,
                ))
            }
        }
    } else {
        eprintln!(
            "warn: unknown scenario '{}', falling back to baseline",
            run_config.scenario
        );
        Box::new(BaselineScenario::new(100.0, 25))
    };
    Ok(scenario)
}

fn load_current_state_pack(
    cli_state_pack: Option<&PathBuf>,
    config_path: &Path,
) -> Result<Option<StatePackImport>> {
    let Some(path) = cli_state_pack
        .cloned()
        .or_else(|| state_pack_path_from_run_config(config_path))
    else {
        return Ok(None);
    };
    let resolved = if path.is_absolute() {
        path
    } else {
        config_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(path)
    };
    load_state_pack(&resolved)
        .map(Some)
        .map_err(|e| anyhow::anyhow!("{e}"))
}

fn state_pack_path_from_run_config(config_path: &Path) -> Option<PathBuf> {
    let raw = fs::read_to_string(config_path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("state_pack")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
}

fn simulation_boundaries_with_state_pack(
    mut boundaries: Vec<String>,
    state_pack: Option<&StatePackImport>,
) -> Vec<String> {
    if state_pack.is_some() {
        boundaries.push(
            "State pack hydration uses current RPC account bytes; transaction signatures are account-discovery hints, not historical pre-state replay.".into(),
        );
    }
    boundaries
}

fn load_adapter_replay_state(
    adapter: &Adapter,
    adapter_path: Option<&Path>,
) -> Result<Option<ReplayStateImport>> {
    let Some(replay) = adapter
        .semantics
        .as_ref()
        .and_then(|semantics| semantics.replay.as_ref())
    else {
        return Ok(None);
    };
    let base_dir = adapter_path
        .and_then(Path::parent)
        .unwrap_or_else(|| Path::new("."));
    import_replay_state(replay, base_dir)
        .map(Some)
        .map_err(|e| anyhow::anyhow!("{e}"))
}

fn apply_generic_state_pack(
    harness: &mut GenericHarness,
    import: Option<&StatePackImport>,
) -> Result<()> {
    let Some(import) = import else {
        return Ok(());
    };
    for account in &import.accounts {
        let binding_name = account.account_name.as_deref().or(account.role.as_deref());
        if let Some(name) = binding_name {
            harness
                .bind_imported_account(name, vec![account.pubkey])
                .map_err(|e| {
                    anyhow::anyhow!(
                        "failed to bind state-pack account {} to adapter account `{name}`: {e:#}",
                        account.pubkey
                    )
                })?;
        }
        harness
            .svm_mut()
            .set_account(account.pubkey, account.account.clone())
            .map_err(|e| {
                anyhow::anyhow!(
                    "failed to hydrate state-pack account {}: {e}",
                    account.pubkey
                )
            })?;
    }
    Ok(())
}

fn apply_generic_replay_state(
    harness: &mut GenericHarness,
    import: Option<&ReplayStateImport>,
) -> Result<()> {
    let Some(import) = import else {
        return Ok(());
    };
    for (role, accounts) in &import.accounts {
        let pubkeys: Vec<_> = accounts.iter().map(|account| account.pubkey).collect();
        let account_name = harness.replay_account_name_for_role(role)?;
        harness
            .bind_imported_account(&account_name, pubkeys)
            .map_err(|e| {
                anyhow::anyhow!(
                    "failed to bind imported replay role `{role}` to account `{account_name}`: {e:#}"
                )
            })?;
        for account in accounts {
            harness
                .svm_mut()
                .set_account(account.pubkey, account.account.clone())
                .map_err(|e| {
                    anyhow::anyhow!("failed to import replay account {}: {e}", account.pubkey)
                })?;
        }
    }
    Ok(())
}

fn lookup_preset<'a>(
    presets: &'a std::collections::HashMap<String, PresetSpec>,
    key: &str,
) -> Option<&'a PresetSpec> {
    if let Some(spec) = presets.get(key) {
        return Some(spec);
    }
    let alias = if key.contains('-') {
        key.replace('-', "_")
    } else if key.contains('_') {
        key.replace('_', "-")
    } else {
        return None;
    };
    presets.get(&alias)
}

fn load_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let raw = fs::read_to_string(path).map_err(|e| friendly_read_error("run-config", path, e))?;
    let parsed = serde_json::from_str(&raw).map_err(|e| {
        anyhow::anyhow!(
            "failed to parse run-config JSON at {}: {e}\n\
             Check for a trailing comma, missing quote, or a field with the wrong type \
             near the reported line/column.",
            path.display()
        )
    })?;
    Ok(parsed)
}

fn load_policies(path: &Path) -> Result<Vec<Policy>> {
    let raw = fs::read_to_string(path).map_err(|e| friendly_read_error("policies", path, e))?;
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|e| {
        anyhow::anyhow!(
            "failed to parse policies JSON at {}: {e}\n\
             Check for a trailing comma, missing quote, or a field with the wrong type \
             near the reported line/column.",
            path.display()
        )
    })?;
    if value.is_array() {
        Ok(serde_json::from_value(value)?)
    } else {
        Ok(vec![serde_json::from_value(value)?])
    }
}

fn write_result(path: &Path, result: &SimulationResult) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = File::create(path)?;
    serde_json::to_writer_pretty(&mut file, result)?;
    file.write_all(b"\n")?;
    Ok(())
}

fn count_invariant_firings(result: &SimulationResult) -> u64 {
    result
        .summary
        .get("invariants_fired")
        .and_then(|v| v.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    entry
                        .get("firing_count")
                        .or_else(|| entry.get("firings"))
                        .and_then(|v| v.as_u64())
                })
                .sum()
        })
        .unwrap_or(0)
}

fn count_error_expression_invariant_firings(result: &SimulationResult) -> u64 {
    result
        .summary
        .get("expression_invariants")
        .and_then(|v| v.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter(|entry| {
                    entry
                        .get("severity")
                        .and_then(|v| v.as_str())
                        .map(|severity| severity == "error")
                        .unwrap_or(false)
                })
                .filter_map(|entry| {
                    entry
                        .get("firing_count")
                        .or_else(|| entry.get("firings"))
                        .and_then(|v| v.as_u64())
                })
                .sum()
        })
        .unwrap_or(0)
}

fn friendly_read_error(kind: &str, path: &Path, source: std::io::Error) -> anyhow::Error {
    anyhow::anyhow!("failed to read {kind} at {}: {source}", path.display())
}
