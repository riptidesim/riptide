//! `riptide-engine` binary entry point.
//!
//! End-to-end responsibilities:
//!   1. Parse CLI args (clap derive).
//!   2. Load run config + policies JSON, plus an optional adapter TOML.
//!   3. Bootstrap an in-process LiteSVM environment against either the
//!      native lending primitive (Solend fork) or the `GenericPrimitive`
//!      path, selected by the adapter's `protocol` field.
//!   4. Construct the appropriate harness and call the matching
//!      `run_simulation` / `run_generic_simulation` entry point.
//!   5. Write the `SimulationResult` JSON to `--output`.
//!
//! Progress/warnings go to stderr; nothing but the `SimulationResult` JSON
//! ever touches the output file. stdout is reserved.

use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    process::ExitCode,
};

use clap::Parser;
use riptide_engine::{
    agent::policy::LENDING_RUNTIME_ACTIONS,
    adapter::{load_adapter, Protocol},
    harness::{
        lending::LendingPoolConfig,
        setup::default_program_so_path,
    },
    primitive::{
        build_generic_policies, generic_runtime_actions, GenericBootstrapConfig, GenericHarness,
    },
    scenario::{
        load_presets_dir, BaselineScenario, PresetSpec, PriceShockScenario, Scenario, ScenarioKind,
    },
    sim::{
        build_agent_personas,
        litesvm::LiteSvmBootstrapConfig,
        run_generic_simulation, run_simulation, LiteSvmHarness, SimulationParams,
    },
    types::{Policy, RunConfig, SimulationResult},
};

#[derive(Debug, Parser)]
#[command(
    name = "riptide-engine",
    version,
    about = "Riptide simulation engine — protocol-agnostic multi-agent simulator",
    long_about = "Tick-based multi-agent simulator for shared program state under time \
                  pressure. Runs an in-process LiteSVM backend (no external validator \
                  required) against a native lending primitive or a generic primitive \
                  driven by an adapter TOML; writes a SimulationResult JSON to --output."
)]
struct Cli {
    /// Path to the run configuration JSON file.
    #[arg(long, value_name = "FILE")]
    config: PathBuf,

    /// Path to the compiled policies JSON file (either one policy object or
    /// an array of policy objects).
    #[arg(long, value_name = "FILE")]
    policies: PathBuf,

    /// Path where the simulation result JSON should be written. Created (or
    /// truncated) on every run.
    #[arg(long, value_name = "FILE")]
    output: PathBuf,

    /// Path to the compiled `lending_pool.so` artifact. Defaults to the
    /// standard `cargo build-sbf` output location inside the workspace.
    #[arg(long, value_name = "FILE")]
    program_so: Option<PathBuf>,

    /// Optional adapter TOML. When present, the engine selects its
    /// primitive impl from the adapter's `protocol` field instead of a
    /// compile-time switch. Missing flag falls back to the default
    /// lending primitive (Solend fork) so existing callers keep working.
    #[arg(long, value_name = "FILE")]
    adapter: Option<PathBuf>,

    /// Sprint 6 T03 — override the invariant-violation exit code back
    /// to 0. By default the engine exits 1 whenever one or more
    /// declared invariants fired during the run (machine-checkable
    /// validation). This flag is for exploratory runs where invariant
    /// firings are expected findings rather than failures.
    #[arg(long, default_value_t = false)]
    allow_invariant_violations: bool,
}

/// Sprint 6 T03 — structured engine outcomes.
///
/// The engine uses three distinct exit codes to give CI (and humans)
/// a machine-checkable signal:
///   - `0` = clean run, all declared invariants held.
///   - `1` = at least one declared invariant fired during the run.
///   - `2` = setup error before the tick loop ran to completion
///           (adapter parse/validation error, missing program `.so`,
///           invariant references unknown field, …). Any non-setup
///           runtime failure (LiteSVM infra error, panic in primitive)
///           also maps to `2`, since the engine never reached a clean
///           declared-invariant verdict.
///
/// Empty-adapter runs (no `[[invariants]]` block declared) always
/// exit `0` on a successful tick loop, matching the Sprint 4 and
/// Sprint 5 default behavior byte-for-byte. This is load-bearing for
/// the Sprint 4 hero-grid determinism hash.
enum EngineOutcome {
    Clean,
    InvariantFired(u64),
    SetupError,
}

impl EngineOutcome {
    fn exit_code(&self, allow_invariant_violations: bool) -> ExitCode {
        match self {
            Self::Clean => ExitCode::SUCCESS,
            Self::SetupError => ExitCode::from(2),
            Self::InvariantFired(_) if allow_invariant_violations => ExitCode::SUCCESS,
            Self::InvariantFired(_) => ExitCode::FAILURE,
        }
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let allow_invariant_violations = cli.allow_invariant_violations;
    match run(cli) {
        Ok(outcome) => {
            match &outcome {
                EngineOutcome::InvariantFired(count) => {
                    if allow_invariant_violations {
                        eprintln!(
                            "riptide-engine: {count} invariant violation(s) recorded; \
                             --allow-invariant-violations restores exit 0"
                        );
                    } else {
                        eprintln!(
                            "riptide-engine: {count} invariant violation(s); exiting 1. \
                             Pass --allow-invariant-violations to treat as exit 0."
                        );
                    }
                }
                EngineOutcome::Clean | EngineOutcome::SetupError => {}
            }
            outcome.exit_code(allow_invariant_violations)
        }
        Err(err) => {
            eprintln!("error: {err:#}");
            EngineOutcome::SetupError.exit_code(allow_invariant_violations)
        }
    }
}

fn run(cli: Cli) -> anyhow::Result<EngineOutcome> {
    let run_config: RunConfig = load_json(&cli.config)?;
    let loaded_policies: Vec<Policy> = load_policies(&cli.policies)?;

    eprintln!(
        "riptide-engine: loaded {} policies, agents={}, ticks={}, scenario={}",
        loaded_policies.len(),
        run_config.agents,
        run_config.ticks,
        run_config.scenario,
    );

    // --- Optional adapter TOML. Selects the primitive at runtime. ---
    //
    // When `--adapter` is absent, the engine boots the Solend-fork
    // `LendingPrimitive` on LiteSVM.
    //
    // When `--adapter` is present, the loader validates the TOML and
    // the `protocol` field picks the primitive impl. The adapter's
    // `[instructions]` and `[state_mapping]` are load-bearing — they
    // are threaded into `LiteSvmBootstrapConfig` and the primitive
    // validates them against its own wiring at bootstrap time. A
    // schema-valid but semantically-wrong adapter (e.g. `deposit`
    // wired to action `borrow`) fails bootstrap before any on-chain
    // state is touched.
    let adapter = if let Some(adapter_path) = cli.adapter.as_ref() {
        let loaded = load_adapter(adapter_path).map_err(|e| anyhow::anyhow!("{e}"))?;
        match loaded.protocol {
            Protocol::Lending => {
                eprintln!(
                    "adapter: {} (lending, {} instructions, {} state mappings)",
                    adapter_path.display(),
                    loaded.instructions.len(),
                    loaded.state_mapping.len()
                );
                Some(loaded)
            }
            Protocol::Generic => {
                eprintln!(
                    "adapter: {} (generic, {} instructions, {} actions, {} observations, {} personas)",
                    adapter_path.display(),
                    loaded.instructions.len(),
                    loaded.actions.len(),
                    loaded.observations.len(),
                    loaded.personas.len(),
                );
                Some(loaded)
            }
        }
    } else {
        None
    };
    let generic_mode = matches!(
        adapter.as_ref().map(|adapter| adapter.protocol),
        Some(Protocol::Generic)
    );
    if !generic_mode && loaded_policies.is_empty() {
        anyhow::bail!("no policies found in {}", cli.policies.display());
    }

    // --- Pool risk params (tunable via env vars, same as before). ---
    let ltv_bps: u16 = std::env::var("RIPTIDE_POOL_LTV_BPS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(7_000);
    let liquidation_threshold_bps: u16 = std::env::var("RIPTIDE_POOL_LIQ_THRESHOLD_BPS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8_000);
    let liquidation_bonus_bps: u16 = std::env::var("RIPTIDE_POOL_LIQ_BONUS_BPS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(500);
    let pool_config = LendingPoolConfig {
        ltv_bps,
        liquidation_threshold_bps,
        liquidation_bonus_bps,
        interest_bps: 250,
        deposit_limit: u64::MAX / 4,
        borrow_limit: u64::MAX / 4,
    };

    let seed_amount: u64 = std::env::var("RIPTIDE_SEED_COLLATERAL")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(100);

    let starting_price_f64: f64 = 100.0;
    let starting_price_u64: u64 = 100;

    // --- Build scenario. ---
    //
    // T02: scenario *parameters* live in `fixtures/scenarios/presets/*.toml`
    // and are loaded at boot into a map keyed by preset `name`. The Rust
    // `Scenario` impls (e.g. `PriceShockScenario`) still live in
    // `scenario::presets` — only the parameter set travels into TOML.
    //
    // Dispatch order:
    //   1. `baseline` stays a hardcoded default so a stripped checkout
    //      still runs without the fixtures tree on disk.
    //   2. Otherwise look up `run_config.scenario` in the preset map and
    //      instantiate the Rust impl matching `preset.kind`.
    //   3. Unknown scenario -> fall back to baseline with a warning
    //      (preserves pre-T02 behavior).
    let presets_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("engine crate has a parent directory")
        .join("fixtures/scenarios/presets");
    let scenario_presets = load_presets_dir(&presets_dir)
        .map_err(|e| anyhow::anyhow!("load scenario presets: {e:#}"))?;
    let mut scenario: Box<dyn Scenario> = if run_config.scenario == "baseline" {
        Box::new(BaselineScenario::new(starting_price_f64, 25))
    } else if let Some(preset) = lookup_preset(&scenario_presets, &run_config.scenario) {
        match preset.kind {
            ScenarioKind::PriceShock => {
                // `RIPTIDE_PRICE_SHOCK_DROP` still overrides the preset's
                // `drop_percent` — this preserves the env-var knob the
                // Sprint 4 hero grid sweep relies on.
                let drop = std::env::var("RIPTIDE_PRICE_SHOCK_DROP")
                    .ok()
                    .and_then(|s| s.parse::<f64>().ok())
                    .filter(|v| (0.0..1.0).contains(v))
                    .unwrap_or(preset.drop_percent);
                let shock_tick =
                    (run_config.ticks / preset.shock_tick_denominator.max(1)).max(1);
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
        Box::new(BaselineScenario::new(starting_price_f64, 25))
    };

    let starting_balance: f64 = std::env::var("RIPTIDE_STARTING_BALANCE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(20_000.0);
    let result = match adapter {
        Some(adapter) if matches!(adapter.protocol, Protocol::Generic) => {
            if !loaded_policies.is_empty() {
                eprintln!(
                    "warn: ignoring {} external policies from {} because protocol=`generic` uses inline adapter personas",
                    loaded_policies.len(),
                    cli.policies.display()
                );
            }

            let policies = build_generic_policies(&adapter, |warning| eprintln!("warn: {warning}"))
                .map_err(|e| anyhow::anyhow!("compile generic adapter personas: {e:#}"))?;
            let agent_personas =
                build_agent_personas(&run_config.personas, &policies, run_config.agents as usize)
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
            let program_so = cli.program_so.unwrap_or_else(|| {
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

            eprintln!("bootstrapping LiteSVM backend (generic) ...");
            let mut harness = GenericHarness::bootstrap(GenericBootstrapConfig {
                program_so,
                idl_path,
                agent_count: run_config.agents as usize,
                adapter: adapter.clone(),
            })
            .map_err(|e| anyhow::anyhow!("LiteSVM generic bootstrap failed: {e:#}"))?;
            eprintln!(
                "LiteSVM ready: program={}, agents={}, protocol=generic",
                harness.program_id,
                harness.agents.len(),
            );

            let params = SimulationParams {
                run_config: &run_config,
                policies,
                agent_personas,
                available_actions: generic_runtime_actions(&adapter),
                starting_balance,
                starting_price: starting_price_f64,
                simulation_boundaries: vec![
                    "In-process LiteSVM backend (no external validator).".into(),
                    "Generic adapters expose only adapter-defined actions/observations; no default TVL/health semantics are inferred.".into(),
                    "Pool-wide TVL/utilization metrics are zeroed on the generic path until a protocol-specific aggregate is declared.".into(),
                    "Custom actions do not mutate engine cash/PnL by default; only on-chain account observations are authoritative.".into(),
                ],
                invariants: adapter.invariants.clone(),
                scheduled_actions: adapter.scheduled_actions.clone(),
            };

            eprintln!("running tick loop ...");
            run_generic_simulation(&mut harness, scenario.as_mut(), params)
                .map_err(|e| anyhow::anyhow!("{e}"))?
        }
        adapter => {
            let program_so = cli.program_so.unwrap_or_else(default_program_so_path);
            if !program_so.exists() {
                anyhow::bail!(
                    "program .so missing at {} (run `cargo build-sbf --manifest-path programs/lending_pool/Cargo.toml` first)",
                    program_so.display()
                );
            }

            // Sprint 5 T01: pull the adapter's declared invariants *before*
            // the bootstrap config consumes the adapter by move. Empty when
            // no adapter was supplied so the default Solend-fork path keeps
            // producing byte-identical output against the Sprint 4 hash.
            let lending_invariants = adapter
                .as_ref()
                .map(|a| a.invariants.clone())
                .unwrap_or_default();
            let lending_scheduled_actions = adapter
                .as_ref()
                .map(|a| a.scheduled_actions.clone())
                .unwrap_or_default();

            eprintln!("bootstrapping LiteSVM backend ...");
            let bootstrap_config = LiteSvmBootstrapConfig {
                program_so,
                agent_count: run_config.agents as usize,
                starting_price: starting_price_u64,
                price_exponent: 0,
                pool_config,
                seed_deposit: seed_amount,
                adapter,
            };
            let mut harness = LiteSvmHarness::bootstrap(bootstrap_config)
                .map_err(|e| anyhow::anyhow!("LiteSVM bootstrap failed: {e:#}"))?;
            eprintln!(
                "LiteSVM ready: program={}, agents={}, seed_deposit={}",
                harness.program_id,
                harness.agents.len(),
                seed_amount,
            );

            let agent_personas = build_agent_personas(
                &run_config.personas,
                &loaded_policies,
                run_config.agents as usize,
            )
            .map_err(|e| anyhow::anyhow!("{e}"))?;
            let params = SimulationParams {
                run_config: &run_config,
                policies: loaded_policies,
                agent_personas,
                available_actions: LENDING_RUNTIME_ACTIONS.to_vec(),
                starting_balance,
                starting_price: starting_price_f64,
                simulation_boundaries: vec![
                    "In-process LiteSVM backend (no external validator).".into(),
                    "No slippage, fees, or MEV modeled.".into(),
                    "Oracle prices are scenario-driven, not external feeds.".into(),
                    "Agents funded via deterministic airdrop, not realistic onboarding.".into(),
                ],
                invariants: lending_invariants,
                scheduled_actions: lending_scheduled_actions,
            };

            eprintln!("running tick loop ...");
            run_simulation(&mut harness, scenario.as_mut(), params)
                .map_err(|e| anyhow::anyhow!("{e}"))?
        }
    };

    write_result(&cli.output, &result)?;
    eprintln!("wrote {}", cli.output.display());

    // Sprint 6 T03 — derive exit code from invariant violations. The
    // count is the total number of events the tick loop emitted via
    // `evaluate_invariants` (one event per falsified comparison per
    // tick), which matches what `summary["invariants_fired"]` rolls up.
    // Runs with no declared invariants never emit an `invariants_fired`
    // key, so `firing_count` stays 0 and the exit code stays 0 — this
    // is the Sprint 4 / Sprint 5 regression-gate contract.
    let firing_count = count_invariant_firings(&result);
    if firing_count > 0 {
        Ok(EngineOutcome::InvariantFired(firing_count))
    } else {
        Ok(EngineOutcome::Clean)
    }
}

/// Count invariant firings across the whole run by summing the
/// per-invariant `firings` entries in `summary["invariants_fired"]`.
/// A fresh run with no declared invariants skips the summary key
/// entirely and returns 0.
fn count_invariant_firings(result: &SimulationResult) -> u64 {
    result
        .summary
        .get("invariants_fired")
        .and_then(|v| v.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| entry.get("firings").and_then(|v| v.as_u64()))
                .sum()
        })
        .unwrap_or(0)
}

/// Look up a preset by dispatch key, matching either the exact `name`
/// field or its hyphen/underscore twin. Pre-T02 the engine accepted
/// `"price-shock"` and `"price_shock"` for the same scenario; this helper
/// preserves that alias so existing run-configs keep resolving.
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

fn load_json<T: serde::de::DeserializeOwned>(path: &Path) -> anyhow::Result<T> {
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

/// Policies file may be either an array or a single object.
fn load_policies(path: &Path) -> anyhow::Result<Vec<Policy>> {
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

/// Produce a cold-user-friendly wrapper around a filesystem read error.
/// ENOENT gets a "did you mean" hint pointing at the shipped demo
/// configs so first-run failures point at a concrete, known-good example
/// instead of leaving the user to guess.
fn friendly_read_error(kind: &str, path: &Path, source: std::io::Error) -> anyhow::Error {
    if source.kind() == std::io::ErrorKind::NotFound {
        let hint = match kind {
            "run-config" => {
                "Try one of the shipped examples: demo/configs/safe.json or demo/configs/stressed.json, \
                 or check that --config points at a readable JSON file."
            }
            "policies" => {
                "The policies file is the JSON emitted by `riptide simulate` after compiling personas \
                 — check that --policies points at a readable file, or let the CLI compile personas \
                 for you instead of invoking the engine directly."
            }
            _ => "Check that the path points at a readable file.",
        };
        anyhow::anyhow!(
            "{kind} file not found at {}\n{hint}",
            path.display()
        )
    } else {
        anyhow::anyhow!("read {} failed: {source}", path.display())
    }
}

fn write_result(path: &Path, result: &SimulationResult) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| anyhow::anyhow!("mkdir {}: {e}", parent.display()))?;
        }
    }
    let serialized = serde_json::to_string_pretty(result)?;
    let mut file =
        File::create(path).map_err(|e| anyhow::anyhow!("create {}: {e}", path.display()))?;
    file.write_all(serialized.as_bytes())?;
    file.write_all(b"\n")?;
    Ok(())
}
