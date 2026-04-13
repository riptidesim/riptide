//! `riptide-engine` binary entry point.
//!
//! End-to-end responsibilities:
//!   1. Parse CLI args (clap derive).
//!   2. Load run config + policies JSON.
//!   3. Bootstrap an in-process LiteSVM environment with the lending program.
//!   4. Construct a `LiteSvmHarness` and call `run_simulation`.
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
    scenario::{BaselineScenario, PriceShockScenario, Scenario},
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
    about = "Riptide simulation engine",
    long_about = "Tick-based multi-agent lending-pool simulator. Runs an in-process \
                  LiteSVM backend (no external validator required); writes a \
                  SimulationResult JSON to --output."
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
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("error: {err:#}");
            ExitCode::FAILURE
        }
    }
}

fn run(cli: Cli) -> anyhow::Result<()> {
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
    // When `--adapter` is absent, behavior is unchanged from Sprint 2:
    // the engine boots the Solend-fork `LendingPrimitive` on LiteSVM.
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
    let mut scenario: Box<dyn Scenario> = match run_config.scenario.as_str() {
        "baseline" => Box::new(BaselineScenario::new(starting_price_f64, 25)),
        "price-shock" | "price_shock" => {
            let drop = std::env::var("RIPTIDE_PRICE_SHOCK_DROP")
                .ok()
                .and_then(|s| s.parse::<f64>().ok())
                .filter(|v| (0.0..1.0).contains(v))
                .unwrap_or(0.4);
            Box::new(PriceShockScenario::new(
                starting_price_f64,
                25,
                (run_config.ticks / 2).max(1),
                drop,
            ))
        }
        other => {
            eprintln!("warn: unknown scenario '{other}', falling back to baseline");
            Box::new(BaselineScenario::new(starting_price_f64, 25))
        }
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
            };

            eprintln!("running tick loop ...");
            run_simulation(&mut harness, scenario.as_mut(), params)
                .map_err(|e| anyhow::anyhow!("{e}"))?
        }
    };

    write_result(&cli.output, &result)?;
    eprintln!("wrote {}", cli.output.display());
    Ok(())
}

fn load_json<T: serde::de::DeserializeOwned>(path: &Path) -> anyhow::Result<T> {
    let raw =
        fs::read_to_string(path).map_err(|e| anyhow::anyhow!("read {}: {e}", path.display()))?;
    let parsed =
        serde_json::from_str(&raw).map_err(|e| anyhow::anyhow!("parse {}: {e}", path.display()))?;
    Ok(parsed)
}

/// Policies file may be either an array or a single object.
fn load_policies(path: &Path) -> anyhow::Result<Vec<Policy>> {
    let raw =
        fs::read_to_string(path).map_err(|e| anyhow::anyhow!("read {}: {e}", path.display()))?;
    let value: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| anyhow::anyhow!("parse {}: {e}", path.display()))?;
    if value.is_array() {
        Ok(serde_json::from_value(value)?)
    } else {
        Ok(vec![serde_json::from_value(value)?])
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
