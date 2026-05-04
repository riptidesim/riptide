// Adapted from Trident (MIT) — https://github.com/Ackee-Blockchain/trident

use std::{any::Any, collections::BTreeMap, fs, path::PathBuf, process::ExitCode, str::FromStr};

use anyhow::{anyhow, Result};
use clap::Parser;
use serde::Serialize;
use solana_sdk::pubkey::Pubkey;

use crate::{
    rng::{seed_from_hex, seed_to_hex},
    TxOutcome, World,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FlowSpec {
    pub name: &'static str,
    pub weight: u64,
}

pub trait IntoSimResult {
    fn into_sim_result(self) -> Result<()>;
}

impl IntoSimResult for () {
    fn into_sim_result(self) -> Result<()> {
        Ok(())
    }
}

impl IntoSimResult for Result<()> {
    fn into_sim_result(self) -> Result<()> {
        self
    }
}

pub trait RiptideSimulation: Default {
    fn world(&mut self) -> &mut World;
    fn __riptide_init(&mut self) -> Result<()>;
    fn __riptide_dispatch_flow(&mut self, idx: usize) -> Result<()>;
    fn __riptide_end(&mut self) -> Result<()>;
    fn __riptide_flow_table() -> &'static [FlowSpec];
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerConfig {
    pub iterations: u64,
    pub flows_per_iteration: u64,
    pub seed: [u8; 32],
    pub debug: bool,
    pub out_dir: Option<PathBuf>,
}

impl Default for RunnerConfig {
    fn default() -> Self {
        Self {
            iterations: 1,
            flows_per_iteration: 1,
            seed: [0x52; 32],
            debug: false,
            out_dir: None,
        }
    }
}

pub struct SimulationRunner<T: RiptideSimulation> {
    config: RunnerConfig,
    _marker: std::marker::PhantomData<T>,
}

impl<T: RiptideSimulation> SimulationRunner<T> {
    pub fn new(config: RunnerConfig) -> Self {
        Self {
            config,
            _marker: std::marker::PhantomData,
        }
    }

    pub fn run(&self) -> Result<()> {
        let mut artifact = GuidedSimRunArtifact::new(&self.config);
        let mut first_error: Option<String> = None;
        let mut metrics_artifact_filename: Option<PathBuf> = None;

        for iteration in 0..self.config.iterations {
            let seed = iteration_seed(self.config.seed, iteration);
            eprintln!(
                "riptide sim iteration={} seed={}",
                iteration,
                seed_to_hex(&seed)
            );
            let report = self.run_iteration(iteration, seed);
            if metrics_artifact_filename.is_none() {
                metrics_artifact_filename = report.metrics_artifact_filename.clone();
            }
            if let Some(error) = &report.error {
                eprintln!(
                    "riptide sim failure iteration={} seed={}",
                    iteration,
                    seed_to_hex(&seed)
                );
                artifact.retained_failing_seed = Some(seed_to_hex(&seed));
                first_error = Some(error.clone());
                artifact.iterations.push(report.artifact);
                break;
            }
            artifact.iterations.push(report.artifact);
        }

        artifact.finalize();
        if let Some(out_dir) = &self.config.out_dir {
            write_run_artifact(out_dir, &artifact)?;
        } else if let Some(filename) = metrics_artifact_filename {
            write_run_artifact_file(&filename, &artifact)?;
        }

        match first_error {
            Some(error) => Err(anyhow!(error)),
            None => Ok(()),
        }
    }

    fn run_iteration(&self, iteration: u64, seed: [u8; 32]) -> IterationRun {
        let mut simulation = T::default();
        simulation.world().set_rng_seed(seed);
        let mut flow_counts = BTreeMap::new();
        let mut dispatched_flows = 0u64;
        let table = T::__riptide_flow_table();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            simulation.__riptide_init()?;
            for _ in 0..self.config.flows_per_iteration {
                let idx = pick_flow(table, simulation.world())?;
                let name = table[idx].name.to_owned();
                *flow_counts.entry(name).or_insert(0) += 1;
                dispatched_flows = dispatched_flows.saturating_add(1);
                simulation.__riptide_dispatch_flow(idx)?;
                simulation.world().tick_services();
            }
            simulation.__riptide_end()
        }));

        let mut error = None;
        let mut panic = false;
        match result {
            Ok(Ok(())) => {
                if self.config.debug {
                    dump_tx_log(simulation.world());
                }
            }
            Ok(Err(run_error)) => {
                dump_tx_log(simulation.world());
                error = Some(format!("{run_error:#}"));
            }
            Err(payload) => {
                dump_tx_log(simulation.world());
                panic = true;
                error = Some(format!("simulation panicked: {}", panic_message(&payload)));
            }
        }

        let regression = match collect_regression_hashes(simulation.world()) {
            Ok(regression) => regression,
            Err(regression_error) => {
                if error.is_none() {
                    error = Some(format!("regression hash failed: {regression_error:#}"));
                }
                RegressionArtifact::default()
            }
        };

        let world = simulation.world();
        let metrics_artifact_filename = world
            .metrics_config()
            .enabled
            .then(|| world.metrics_config().filename.as_deref())
            .flatten()
            .map(PathBuf::from);
        let tx_log = world.tx_log().to_vec();
        let status = if panic {
            "panic"
        } else if error.is_some() {
            "failed"
        } else {
            "passed"
        }
        .to_owned();

        IterationRun {
            error: error.clone(),
            metrics_artifact_filename,
            artifact: GuidedSimIterationArtifact {
                iteration,
                seed: seed_to_hex(&seed),
                status,
                dispatched_flows,
                flow_counts,
                tx_outcomes: tx_log,
                service_ticks: world.service_tick_count(),
                regression,
                error,
                panic,
            },
        }
    }
}

pub fn run<T>() -> ExitCode
where
    T: RiptideSimulation,
{
    let args = RunnerArgs::parse();
    match args
        .try_into_config()
        .and_then(|config| SimulationRunner::<T>::new(config).run())
    {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("riptide sim: {error:#}");
            ExitCode::from(1)
        }
    }
}

fn pick_flow(table: &[FlowSpec], world: &mut World) -> Result<usize> {
    if table.is_empty() {
        anyhow::bail!("simulation has no #[flow] methods");
    }
    let total: u64 = table.iter().map(|flow| flow.weight).sum();
    if total == 0 {
        anyhow::bail!("simulation flow table has total weight 0");
    }
    let mut cursor = world.rng().random_from_range(0..total);
    for (idx, flow) in table.iter().enumerate() {
        if cursor < flow.weight {
            return Ok(idx);
        }
        cursor -= flow.weight;
    }
    Ok(table.len() - 1)
}

fn iteration_seed(mut seed: [u8; 32], iteration: u64) -> [u8; 32] {
    let bytes = iteration.to_le_bytes();
    for (idx, byte) in bytes.iter().enumerate() {
        seed[24 + idx] ^= byte;
    }
    seed
}

#[derive(Debug)]
struct IterationRun {
    artifact: GuidedSimIterationArtifact,
    error: Option<String>,
    metrics_artifact_filename: Option<PathBuf>,
}

#[derive(Debug, Serialize)]
struct GuidedSimRunArtifact {
    schema_version: u32,
    status: String,
    iterations_requested: u64,
    flows_per_iteration: u64,
    base_seed: String,
    retained_failing_seed: Option<String>,
    totals: GuidedSimTotals,
    iterations: Vec<GuidedSimIterationArtifact>,
}

impl GuidedSimRunArtifact {
    fn new(config: &RunnerConfig) -> Self {
        Self {
            schema_version: 1,
            status: "running".to_owned(),
            iterations_requested: config.iterations,
            flows_per_iteration: config.flows_per_iteration,
            base_seed: seed_to_hex(&config.seed),
            retained_failing_seed: None,
            totals: GuidedSimTotals::default(),
            iterations: Vec::new(),
        }
    }

    fn finalize(&mut self) {
        let mut totals = GuidedSimTotals {
            iterations: self.iterations.len() as u64,
            ..GuidedSimTotals::default()
        };
        for iteration in &self.iterations {
            totals.flows = totals.flows.saturating_add(iteration.dispatched_flows);
            totals.service_ticks = totals.service_ticks.saturating_add(iteration.service_ticks);
            if iteration.panic {
                totals.panics = totals.panics.saturating_add(1);
            }
            if iteration.error.is_some() && !iteration.panic {
                totals.errors = totals.errors.saturating_add(1);
            }
            for outcome in &iteration.tx_outcomes {
                totals.compute_units = totals
                    .compute_units
                    .saturating_add(outcome.compute_units_consumed);
                if outcome.ok {
                    totals.tx_success = totals.tx_success.saturating_add(1);
                } else if outcome.expected_error {
                    totals.expected_errors = totals.expected_errors.saturating_add(1);
                } else {
                    totals.unexpected_errors = totals.unexpected_errors.saturating_add(1);
                }
            }
        }
        self.status = if self.retained_failing_seed.is_some() {
            "failed".to_owned()
        } else {
            "passed".to_owned()
        };
        self.totals = totals;
    }
}

#[derive(Debug, Default, Serialize)]
struct GuidedSimTotals {
    iterations: u64,
    flows: u64,
    tx_success: u64,
    expected_errors: u64,
    unexpected_errors: u64,
    compute_units: u64,
    service_ticks: u64,
    errors: u64,
    panics: u64,
}

#[derive(Debug, Serialize)]
struct GuidedSimIterationArtifact {
    iteration: u64,
    seed: String,
    status: String,
    dispatched_flows: u64,
    flow_counts: BTreeMap<String, u64>,
    tx_outcomes: Vec<TxOutcome>,
    service_ticks: u64,
    regression: RegressionArtifact,
    error: Option<String>,
    panic: bool,
}

#[derive(Debug, Default, Serialize)]
struct RegressionArtifact {
    enabled: bool,
    account_hashes: BTreeMap<String, String>,
    expected_state_hashes: Vec<String>,
}

fn collect_regression_hashes(world: &World) -> Result<RegressionArtifact> {
    let config = world.regression_config();
    if !config.enabled {
        return Ok(RegressionArtifact::default());
    }

    let mut account_hashes = BTreeMap::new();
    for account in &config.accounts {
        let pubkey = Pubkey::from_str(account)
            .map_err(|error| anyhow!("invalid regression account pubkey `{account}`: {error}"))?;
        account_hashes.insert(account.clone(), world.account_state_hash(&pubkey)?);
    }

    if !config.state_hashes.is_empty() && config.state_hashes.len() != account_hashes.len() {
        anyhow::bail!(
            "regression state_hashes length {} does not match selected account count {}",
            config.state_hashes.len(),
            account_hashes.len()
        );
    }

    if !config.state_hashes.is_empty() {
        for ((account, actual), expected) in account_hashes.iter().zip(&config.state_hashes) {
            if actual != expected {
                anyhow::bail!(
                    "regression hash mismatch for {account}: expected {expected}, got {actual}"
                );
            }
        }
    }

    Ok(RegressionArtifact {
        enabled: true,
        account_hashes,
        expected_state_hashes: config.state_hashes.clone(),
    })
}

fn write_run_artifact(out_dir: &PathBuf, artifact: &GuidedSimRunArtifact) -> Result<()> {
    fs::create_dir_all(out_dir).map_err(|error| {
        anyhow!(
            "create guided sim artifact dir {}: {error}",
            out_dir.display()
        )
    })?;
    let artifact_path = out_dir.join("guided-sim-run.json");
    fs::write(
        &artifact_path,
        serde_json::to_vec_pretty(artifact).expect("guided sim artifact serializes"),
    )
    .map_err(|error| {
        anyhow!(
            "write guided sim artifact {}: {error}",
            artifact_path.display()
        )
    })?;
    if let Some(seed) = &artifact.retained_failing_seed {
        fs::write(out_dir.join("failing-seed.txt"), format!("{seed}\n")).map_err(|error| {
            anyhow!(
                "write guided sim failing seed {}: {error}",
                out_dir.join("failing-seed.txt").display()
            )
        })?;
    }
    Ok(())
}

fn write_run_artifact_file(path: &PathBuf, artifact: &GuidedSimRunArtifact) -> Result<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).map_err(|error| {
            anyhow!(
                "create guided sim artifact dir {}: {error}",
                parent.display()
            )
        })?;
    }
    fs::write(
        path,
        serde_json::to_vec_pretty(artifact).expect("guided sim artifact serializes"),
    )
    .map_err(|error| anyhow!("write guided sim artifact {}: {error}", path.display()))
}

fn dump_tx_log(world: &mut World) {
    for outcome in world.tx_log() {
        eprintln!(
            "tx label={} ok={} signature={} compute_units={}",
            outcome.label.as_deref().unwrap_or("unlabelled"),
            outcome.ok,
            outcome.signature,
            outcome.compute_units_consumed
        );
        if let Some(error) = &outcome.error {
            eprintln!("  error={error}");
        }
        for log in &outcome.logs {
            eprintln!("  {log}");
        }
    }
}

fn panic_message(payload: &Box<dyn Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }
    if let Some(message) = payload.downcast_ref::<&'static str>() {
        return (*message).to_owned();
    }
    "unknown panic payload".to_owned()
}

#[derive(Debug, Parser)]
struct RunnerArgs {
    #[arg(long, default_value_t = 1)]
    iterations: u64,
    #[arg(long = "flows", default_value_t = 1)]
    flows_per_iteration: u64,
    #[arg(long)]
    seed: Option<String>,
    #[arg(long)]
    debug: bool,
    #[arg(long = "out")]
    out_dir: Option<PathBuf>,
}

impl RunnerArgs {
    fn try_into_config(self) -> Result<RunnerConfig> {
        Ok(RunnerConfig {
            iterations: self.iterations,
            flows_per_iteration: self.flows_per_iteration,
            seed: match self.seed {
                Some(seed) => seed_from_hex(&seed)?,
                None => RunnerConfig::default().seed,
            },
            debug: self.debug,
            out_dir: self.out_dir,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::riptide_sim;
    use serde_json::Value;
    use solana_account::Account;

    #[derive(Default)]
    struct CounterSim {
        world: World,
        hits: u64,
    }

    #[riptide_sim]
    impl CounterSim {
        #[init]
        fn init(&mut self) {
            self.hits = 0;
        }

        #[flow(weight = 100)]
        fn only_flow(&mut self) {
            self.hits += 1;
        }

        #[end]
        fn end(&mut self) -> Result<()> {
            anyhow::ensure!(self.hits == 3, "expected three flow calls");
            Ok(())
        }
    }

    #[test]
    fn runner_dispatches_weighted_flows() {
        let config = RunnerConfig {
            flows_per_iteration: 3,
            ..RunnerConfig::default()
        };
        SimulationRunner::<CounterSim>::new(config).run().unwrap();
    }

    #[test]
    fn runner_writes_stable_json_artifact() {
        let out_dir = unique_temp_dir();
        let config = RunnerConfig {
            iterations: 2,
            flows_per_iteration: 3,
            out_dir: Some(out_dir.clone()),
            ..RunnerConfig::default()
        };

        SimulationRunner::<CounterSim>::new(config).run().unwrap();

        let raw = fs::read_to_string(out_dir.join("guided-sim-run.json")).unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["schema_version"], 1);
        assert_eq!(value["status"], "passed");
        assert_eq!(value["totals"]["iterations"], 2);
        assert_eq!(value["totals"]["flows"], 6);
        assert_eq!(value["iterations"][0]["flow_counts"]["only_flow"], 3);

        let _ = fs::remove_dir_all(out_dir);
    }

    #[derive(Default)]
    struct FailingSim {
        world: World,
    }

    #[riptide_sim]
    impl FailingSim {
        #[init]
        fn init(&mut self) {}

        #[flow(weight = 100)]
        fn failing_flow(&mut self) -> Result<()> {
            anyhow::bail!("intentional flow failure")
        }

        #[end]
        fn end(&mut self) {}
    }

    #[test]
    fn runner_retains_failing_seed_in_artifact() {
        let out_dir = unique_temp_dir();
        let config = RunnerConfig {
            iterations: 3,
            flows_per_iteration: 1,
            out_dir: Some(out_dir.clone()),
            ..RunnerConfig::default()
        };

        let error = SimulationRunner::<FailingSim>::new(config)
            .run()
            .unwrap_err()
            .to_string();
        assert!(error.contains("intentional flow failure"));

        let raw = fs::read_to_string(out_dir.join("guided-sim-run.json")).unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["status"], "failed");
        assert!(value["retained_failing_seed"].as_str().unwrap().len() >= 64);
        assert!(fs::read_to_string(out_dir.join("failing-seed.txt"))
            .unwrap()
            .contains(value["retained_failing_seed"].as_str().unwrap()));

        let _ = fs::remove_dir_all(out_dir);
    }

    #[derive(Default)]
    struct RegressionSim {
        world: World,
    }

    #[riptide_sim]
    impl RegressionSim {
        #[init]
        fn init(&mut self) -> Result<()> {
            let address = regression_address();
            self.world.set_account(
                address,
                Account {
                    lamports: 10,
                    data: b"stable-regression-state".to_vec(),
                    owner: Pubkey::new_from_array([8; 32]),
                    ..Default::default()
                },
            )?;
            self.world.configure_guided_artifacts(
                crate::bootstrap::MetricsConfig::default(),
                crate::bootstrap::RegressionConfig {
                    enabled: true,
                    accounts: vec![address.to_string()],
                    state_hashes: Vec::new(),
                },
            );
            Ok(())
        }

        #[flow(weight = 100)]
        fn noop(&mut self) {}

        #[end]
        fn end(&mut self) {}
    }

    #[test]
    fn runner_writes_regression_account_hashes() {
        let out_dir = unique_temp_dir();
        let config = RunnerConfig {
            out_dir: Some(out_dir.clone()),
            ..RunnerConfig::default()
        };

        SimulationRunner::<RegressionSim>::new(config)
            .run()
            .unwrap();

        let raw = fs::read_to_string(out_dir.join("guided-sim-run.json")).unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        let address = regression_address().to_string();
        let hash = value["iterations"][0]["regression"]["account_hashes"][address.as_str()]
            .as_str()
            .unwrap();
        assert_eq!(hash.len(), 64);

        let _ = fs::remove_dir_all(out_dir);
    }

    #[derive(Default)]
    struct RegressionMismatchSim {
        world: World,
    }

    #[riptide_sim]
    impl RegressionMismatchSim {
        #[init]
        fn init(&mut self) -> Result<()> {
            let address = regression_address();
            self.world.set_account(
                address,
                Account {
                    lamports: 10,
                    data: b"stable-regression-state".to_vec(),
                    owner: Pubkey::new_from_array([8; 32]),
                    ..Default::default()
                },
            )?;
            self.world.configure_guided_artifacts(
                crate::bootstrap::MetricsConfig::default(),
                crate::bootstrap::RegressionConfig {
                    enabled: true,
                    accounts: vec![address.to_string()],
                    state_hashes: vec!["0".repeat(64)],
                },
            );
            Ok(())
        }

        #[flow(weight = 100)]
        fn noop(&mut self) {}

        #[end]
        fn end(&mut self) {}
    }

    #[test]
    fn runner_fails_on_regression_hash_mismatch() {
        let out_dir = unique_temp_dir();
        let config = RunnerConfig {
            out_dir: Some(out_dir.clone()),
            ..RunnerConfig::default()
        };

        let error = SimulationRunner::<RegressionMismatchSim>::new(config)
            .run()
            .unwrap_err()
            .to_string();

        assert!(error.contains("regression hash mismatch"));
        let raw = fs::read_to_string(out_dir.join("guided-sim-run.json")).unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["status"], "failed");
        assert!(value["retained_failing_seed"].is_string());

        let _ = fs::remove_dir_all(out_dir);
    }

    fn regression_address() -> Pubkey {
        Pubkey::new_from_array([7; 32])
    }

    static METRICS_ARTIFACT_PATH: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

    #[derive(Default)]
    struct MetricsFilenameSim {
        world: World,
    }

    #[riptide_sim]
    impl MetricsFilenameSim {
        #[init]
        fn init(&mut self) {
            let filename = METRICS_ARTIFACT_PATH
                .lock()
                .unwrap()
                .clone()
                .expect("test configured metrics artifact path");
            self.world.configure_guided_artifacts(
                crate::bootstrap::MetricsConfig {
                    enabled: true,
                    filename: Some(filename.display().to_string()),
                },
                crate::bootstrap::RegressionConfig::default(),
            );
        }

        #[flow(weight = 100)]
        fn noop(&mut self) {}

        #[end]
        fn end(&mut self) {}
    }

    #[test]
    fn runner_writes_metrics_filename_when_out_is_omitted() {
        let out_dir = unique_temp_dir();
        fs::create_dir_all(&out_dir).unwrap();
        let artifact_path = out_dir.join("guided-sim-metrics.json");
        *METRICS_ARTIFACT_PATH.lock().unwrap() = Some(artifact_path.clone());

        SimulationRunner::<MetricsFilenameSim>::new(RunnerConfig::default())
            .run()
            .unwrap();

        let raw = fs::read_to_string(&artifact_path).unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["schema_version"], 1);
        assert_eq!(value["status"], "passed");

        *METRICS_ARTIFACT_PATH.lock().unwrap() = None;
        let _ = fs::remove_dir_all(out_dir);
    }

    fn unique_temp_dir() -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("riptide-sim-runner-{nanos}"))
    }
}
