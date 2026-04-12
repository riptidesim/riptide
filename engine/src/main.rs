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
    harness::{
        lending::LendingPoolConfig,
        setup::default_program_so_path,
    },
    scenario::{BaselineScenario, PriceShockScenario, Scenario},
    sim::{
        build_agent_personas,
        litesvm::LiteSvmBootstrapConfig,
        run_simulation, LiteSvmHarness, SimulationParams,
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
    let policies: Vec<Policy> = load_policies(&cli.policies)?;
    if policies.is_empty() {
        anyhow::bail!("no policies found in {}", cli.policies.display());
    }

    eprintln!(
        "riptide-engine: loaded {} policies, agents={}, ticks={}, scenario={}",
        policies.len(),
        run_config.agents,
        run_config.ticks,
        run_config.scenario,
    );

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

    // --- Bootstrap the in-process LiteSVM environment. ---
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
    };
    let mut harness = LiteSvmHarness::bootstrap(bootstrap_config)
        .map_err(|e| anyhow::anyhow!("LiteSVM bootstrap failed: {e:#}"))?;
    eprintln!(
        "LiteSVM ready: program={}, agents={}, seed_deposit={}",
        harness.program_id,
        harness.agents.len(),
        seed_amount,
    );

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

    let agent_personas =
        build_agent_personas(&run_config.personas, &policies, run_config.agents as usize)
            .map_err(|e| anyhow::anyhow!("{e}"))?;

    let starting_balance: f64 = std::env::var("RIPTIDE_STARTING_BALANCE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(20_000.0);
    let params = SimulationParams {
        run_config: &run_config,
        policies,
        agent_personas,
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
    let result = run_simulation(&mut harness, scenario.as_mut(), params)
        .map_err(|e| anyhow::anyhow!("{e}"))?;

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
