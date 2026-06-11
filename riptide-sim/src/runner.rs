// Adapted from Trident (MIT) — https://github.com/Ackee-Blockchain/trident

use std::{
    any::Any, cell::Cell, collections::BTreeMap, fs, path::PathBuf, process::ExitCode, str::FromStr,
};

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
    /// When set, the runner sweeps a single named parameter across declared
    /// values, running `seeds_per_value` seed replicates per value. Each
    /// iteration's coordinate is injected into the World (readable via
    /// `sweep_value`) and recorded into the artifact. In sweep mode the loop
    /// does NOT stop at the first failing iteration — failing cells are the
    /// signal a risk surface needs.
    pub sweep: Option<SweepConfig>,
}

/// A single-axis parameter sweep for guided-sim risk-surface generation.
#[derive(Debug, Clone, PartialEq)]
pub struct SweepConfig {
    pub name: String,
    pub values: Vec<f64>,
    pub seeds_per_value: u64,
}

impl Eq for SweepConfig {}

impl SweepConfig {
    /// Total iterations this sweep expands to: one per (value, seed replicate).
    pub fn total_iterations(&self) -> u64 {
        (self.values.len() as u64).saturating_mul(self.seeds_per_value.max(1))
    }

    /// The swept value active for a given global iteration index.
    fn value_for(&self, iteration: u64) -> f64 {
        let per_value = self.seeds_per_value.max(1);
        let value_index = (iteration / per_value) as usize;
        self.values[value_index.min(self.values.len().saturating_sub(1))]
    }
}

impl Default for RunnerConfig {
    fn default() -> Self {
        Self {
            iterations: 1,
            flows_per_iteration: 1,
            seed: [0x52; 32],
            debug: false,
            out_dir: None,
            sweep: None,
        }
    }
}

pub struct SimulationRunner<T: RiptideSimulation> {
    config: RunnerConfig,
    replay_flow_sequence: Option<Vec<usize>>,
    _marker: std::marker::PhantomData<T>,
}

impl<T: RiptideSimulation> SimulationRunner<T> {
    pub fn new(config: RunnerConfig) -> Self {
        Self {
            config,
            replay_flow_sequence: None,
            _marker: std::marker::PhantomData,
        }
    }

    #[allow(dead_code)]
    pub(crate) fn new_with_replay_flow_sequence(
        config: RunnerConfig,
        replay_flow_sequence: impl Into<Vec<usize>>,
    ) -> Self {
        Self {
            config,
            replay_flow_sequence: Some(replay_flow_sequence.into()),
            _marker: std::marker::PhantomData,
        }
    }

    pub fn run(&self) -> Result<()> {
        let mut artifact = GuidedSimRunArtifact::new(&self.config);
        let mut first_error: Option<String> = None;
        let mut metrics_artifact_filename: Option<PathBuf> = None;

        let sweeping = self.config.sweep.is_some();
        let iterations = match &self.config.sweep {
            Some(sweep) => sweep.total_iterations(),
            None => self.config.iterations,
        };

        for iteration in 0..iterations {
            let seed = iteration_seed(self.config.seed, iteration);
            let sweep_point = self
                .config
                .sweep
                .as_ref()
                .map(|sweep| (sweep.name.as_str(), sweep.value_for(iteration)));
            eprintln!(
                "riptide sim iteration={} seed={}",
                iteration,
                seed_to_hex(&seed)
            );
            let report = self.run_iteration(iteration, seed, sweep_point);
            if metrics_artifact_filename.is_none() {
                metrics_artifact_filename = report.metrics_artifact_filename.clone();
            }
            if let Some(error) = &report.error {
                eprintln!(
                    "riptide sim failure iteration={} seed={}",
                    iteration,
                    seed_to_hex(&seed)
                );
                if artifact.retained_failing_seed.is_none() {
                    artifact.retained_failing_seed = Some(seed_to_hex(&seed));
                }
                // In sweep mode a failing iteration is recorded signal, not a
                // run abort: keep going so every parameter cell is populated.
                if !sweeping {
                    first_error = Some(error.clone());
                    artifact.iterations.push(report.artifact);
                    break;
                }
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

    fn run_iteration(
        &self,
        iteration: u64,
        seed: [u8; 32],
        sweep_point: Option<(&str, f64)>,
    ) -> IterationRun {
        let mut simulation = T::default();
        simulation.world().set_rng_seed(seed);
        if let Some((name, value)) = sweep_point {
            // Inject the active sweep coordinate before init/flows so flows can
            // read it via `world.sweep_value(name)`, and so it is recorded into
            // the iteration artifact even if the flow never reads it.
            simulation.world().record_parameter(name, value);
        }
        let mut flow_counts = BTreeMap::new();
        let mut flow_trace = Vec::new();
        let mut first_failing_flow_step = None;
        let mut first_failure = None;
        let active_trace_idx: Cell<Option<usize>> = Cell::new(None);
        let active_non_flow_context: Cell<Option<GuidedSimFailureContext>> = Cell::new(None);
        let mut dispatched_flows = 0u64;
        let table = T::__riptide_flow_table();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let init_context = GuidedSimFailureContext::new("init", None, simulation.world());
            active_non_flow_context.set(Some(init_context));
            if let Err(run_error) = simulation.__riptide_init() {
                let failure_message = format!("{run_error:#}");
                if first_failure.is_none() {
                    first_failure = Some(GuidedSimFailureArtifact::from_context(
                        init_context,
                        simulation.world(),
                        "returned_error",
                        failure_message,
                    ));
                }
                active_non_flow_context.set(None);
                return Err(run_error);
            }
            active_non_flow_context.set(None);

            for step_index in 0..self.config.flows_per_iteration {
                let selection_context = GuidedSimFailureContext::new(
                    "flow_selection",
                    Some(step_index),
                    simulation.world(),
                );
                active_non_flow_context.set(Some(selection_context));
                let idx = match select_flow(
                    table,
                    simulation.world(),
                    self.replay_flow_sequence.as_deref(),
                    step_index,
                ) {
                    Ok(idx) => idx,
                    Err(run_error) => {
                        let failure_message = format!("{run_error:#}");
                        if first_failure.is_none() {
                            first_failure = Some(GuidedSimFailureArtifact::from_context(
                                selection_context,
                                simulation.world(),
                                "returned_error",
                                failure_message,
                            ));
                        }
                        active_non_flow_context.set(None);
                        return Err(run_error);
                    }
                };
                active_non_flow_context.set(None);

                let flow = &table[idx];
                let tx_log_start = simulation.world().tx_log().len();
                let service_ticks_before = simulation.world().service_tick_count();
                flow_trace.push(GuidedSimFlowTraceStep {
                    step_index,
                    flow_index: idx,
                    flow_name: flow.name.to_owned(),
                    tx_log_start: tx_log_start as u64,
                    tx_log_end: tx_log_start as u64,
                    service_ticks_before,
                    service_ticks_after: service_ticks_before,
                    status: "passed".to_owned(),
                    expected_errors: 0,
                    unexpected_errors: 0,
                    failure_message: None,
                });
                let trace_idx = flow_trace.len() - 1;
                active_trace_idx.set(Some(trace_idx));

                let name = flow.name.to_owned();
                *flow_counts.entry(name).or_insert(0) += 1;
                dispatched_flows = dispatched_flows.saturating_add(1);
                if let Err(run_error) = simulation.__riptide_dispatch_flow(idx) {
                    let failure_message = format!("{run_error:#}");
                    finalize_flow_trace_step(
                        &mut flow_trace[trace_idx],
                        simulation.world(),
                        "returned_error",
                        Some(failure_message),
                    );
                    if first_failing_flow_step.is_none() {
                        first_failing_flow_step = Some(flow_trace[trace_idx].clone());
                    }
                    if first_failure.is_none() {
                        first_failure = Some(GuidedSimFailureArtifact::from_flow_trace(
                            &flow_trace[trace_idx],
                        ));
                    }
                    active_trace_idx.set(None);
                    return Err(run_error);
                }
                simulation.world().tick_services();
                finalize_flow_trace_step(
                    &mut flow_trace[trace_idx],
                    simulation.world(),
                    "passed",
                    None,
                );
                active_trace_idx.set(None);
            }

            let end_context = GuidedSimFailureContext::new("end", None, simulation.world());
            active_non_flow_context.set(Some(end_context));
            if let Err(run_error) = simulation.__riptide_end() {
                let failure_message = format!("{run_error:#}");
                if first_failure.is_none() {
                    first_failure = Some(GuidedSimFailureArtifact::from_context(
                        end_context,
                        simulation.world(),
                        "returned_error",
                        failure_message,
                    ));
                }
                active_non_flow_context.set(None);
                return Err(run_error);
            }
            active_non_flow_context.set(None);
            Ok(())
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
                let panic_error = format!("simulation panicked: {}", panic_message(&payload));
                if let Some(trace_idx) = active_trace_idx.take() {
                    finalize_flow_trace_step(
                        &mut flow_trace[trace_idx],
                        simulation.world(),
                        "panic",
                        Some(panic_error.clone()),
                    );
                    if first_failing_flow_step.is_none() {
                        first_failing_flow_step = Some(flow_trace[trace_idx].clone());
                    }
                    if first_failure.is_none() {
                        first_failure = Some(GuidedSimFailureArtifact::from_flow_trace(
                            &flow_trace[trace_idx],
                        ));
                    }
                } else if let Some(context) = active_non_flow_context.take() {
                    if first_failure.is_none() {
                        first_failure = Some(GuidedSimFailureArtifact::from_context(
                            context,
                            simulation.world(),
                            "panic",
                            panic_error.clone(),
                        ));
                    }
                }
                dump_tx_log(simulation.world());
                panic = true;
                error = Some(panic_error);
            }
        }

        let regression_context =
            GuidedSimFailureContext::new("regression", None, simulation.world());
        let regression = match collect_regression_hashes(simulation.world()) {
            Ok(regression) => regression,
            Err(regression_error) => {
                let failure_message = format!("regression hash failed: {regression_error:#}");
                if error.is_none() {
                    error = Some(failure_message.clone());
                }
                if first_failure.is_none() {
                    first_failure = Some(GuidedSimFailureArtifact::from_context(
                        regression_context,
                        simulation.world(),
                        "returned_error",
                        failure_message,
                    ));
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
        let parameters = world.iteration_parameters().clone();
        let metrics = world.iteration_metrics().clone();
        let invariant_fires = world.iteration_invariant_fires().to_vec();
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
                flow_trace,
                first_failing_flow_step,
                first_failure,
                tx_outcomes: tx_log,
                service_ticks: world.service_tick_count(),
                regression,
                error,
                panic,
                parameters,
                metrics,
                invariant_fires,
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

fn select_flow(
    table: &[FlowSpec],
    world: &mut World,
    replay_flow_sequence: Option<&[usize]>,
    step_index: u64,
) -> Result<usize> {
    match replay_flow_sequence {
        Some(sequence) => replay_flow_index(table, sequence, step_index),
        None => pick_flow(table, world),
    }
}

fn replay_flow_index(table: &[FlowSpec], sequence: &[usize], step_index: u64) -> Result<usize> {
    if table.is_empty() {
        anyhow::bail!("simulation has no #[flow] methods");
    }
    let sequence_index = usize::try_from(step_index)
        .map_err(|_| anyhow!("replay step index {step_index} exceeds platform usize"))?;
    let flow_index = *sequence.get(sequence_index).ok_or_else(|| {
        anyhow!(
            "replay flow sequence exhausted at step {step_index}: {} entries available",
            sequence.len()
        )
    })?;
    if flow_index >= table.len() {
        anyhow::bail!(
            "replay flow index {flow_index} at step {step_index} is out of range for {} configured flows",
            table.len()
        );
    }
    Ok(flow_index)
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
    trace_schema_version: u32,
    status: String,
    iterations_requested: u64,
    flows_per_iteration: u64,
    base_seed: String,
    retained_failing_seed: Option<String>,
    totals: GuidedSimTotals,
    iterations: Vec<GuidedSimIterationArtifact>,
    /// True when this artifact came from a parameter sweep. Not serialized:
    /// it only governs the terminal-status rule (a sweep that ran to
    /// completion is `passed` even though individual cells failed).
    #[serde(skip)]
    swept: bool,
}

impl GuidedSimRunArtifact {
    fn new(config: &RunnerConfig) -> Self {
        Self {
            schema_version: 1,
            trace_schema_version: 1,
            status: "running".to_owned(),
            iterations_requested: match &config.sweep {
                Some(sweep) => sweep.total_iterations(),
                None => config.iterations,
            },
            flows_per_iteration: config.flows_per_iteration,
            base_seed: seed_to_hex(&config.seed),
            retained_failing_seed: None,
            totals: GuidedSimTotals::default(),
            iterations: Vec::new(),
            swept: config.sweep.is_some(),
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
        // A sweep that ran to completion is `passed`: failing cells are the
        // recorded signal, not a run abort. Outside a sweep, a retained failing
        // seed means the run stopped on first failure.
        self.status = if self.retained_failing_seed.is_some() && !self.swept {
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
    flow_trace: Vec<GuidedSimFlowTraceStep>,
    first_failing_flow_step: Option<GuidedSimFlowTraceStep>,
    first_failure: Option<GuidedSimFailureArtifact>,
    tx_outcomes: Vec<TxOutcome>,
    service_ticks: u64,
    regression: RegressionArtifact,
    error: Option<String>,
    panic: bool,
    /// Swept-parameter coordinates for this iteration (e.g. `rate_shock_bps`).
    /// Additive and omitted when empty so non-sweep guided-sim artifacts keep
    /// byte-identical serialization (and `trace_schema_version` stays 1).
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    parameters: BTreeMap<String, f64>,
    /// Outcome metrics a flow recorded for risk-surface cell percentiles.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    metrics: BTreeMap<String, f64>,
    /// Error-severity invariant fires a flow recorded; non-empty marks the
    /// iteration as a surface `fail`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    invariant_fires: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct GuidedSimFlowTraceStep {
    step_index: u64,
    flow_index: usize,
    flow_name: String,
    tx_log_start: u64,
    tx_log_end: u64,
    service_ticks_before: u64,
    service_ticks_after: u64,
    status: String,
    expected_errors: u64,
    unexpected_errors: u64,
    failure_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct GuidedSimFailureArtifact {
    stage: String,
    status: String,
    step_index: Option<u64>,
    flow_index: Option<usize>,
    flow_name: Option<String>,
    tx_log_start: u64,
    tx_log_end: u64,
    service_ticks_before: u64,
    service_ticks_after: u64,
    failure_message: String,
}

impl GuidedSimFailureArtifact {
    fn from_flow_trace(step: &GuidedSimFlowTraceStep) -> Self {
        Self {
            stage: "flow".to_owned(),
            status: step.status.clone(),
            step_index: Some(step.step_index),
            flow_index: Some(step.flow_index),
            flow_name: Some(step.flow_name.clone()),
            tx_log_start: step.tx_log_start,
            tx_log_end: step.tx_log_end,
            service_ticks_before: step.service_ticks_before,
            service_ticks_after: step.service_ticks_after,
            failure_message: step.failure_message.clone().unwrap_or_default(),
        }
    }

    fn from_context(
        context: GuidedSimFailureContext,
        world: &World,
        status: &str,
        failure_message: String,
    ) -> Self {
        Self {
            stage: context.stage.to_owned(),
            status: status.to_owned(),
            step_index: context.step_index,
            flow_index: None,
            flow_name: None,
            tx_log_start: context.tx_log_start as u64,
            tx_log_end: world.tx_log().len() as u64,
            service_ticks_before: context.service_ticks_before,
            service_ticks_after: world.service_tick_count(),
            failure_message,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct GuidedSimFailureContext {
    stage: &'static str,
    step_index: Option<u64>,
    tx_log_start: usize,
    service_ticks_before: u64,
}

impl GuidedSimFailureContext {
    fn new(stage: &'static str, step_index: Option<u64>, world: &World) -> Self {
        Self {
            stage,
            step_index,
            tx_log_start: world.tx_log().len(),
            service_ticks_before: world.service_tick_count(),
        }
    }
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

fn finalize_flow_trace_step(
    step: &mut GuidedSimFlowTraceStep,
    world: &World,
    status: &str,
    failure_message: Option<String>,
) {
    let tx_log_end = world.tx_log().len();
    let (expected_errors, unexpected_errors) =
        tx_error_counts(world.tx_log(), step.tx_log_start as usize, tx_log_end);
    step.tx_log_end = tx_log_end as u64;
    step.service_ticks_after = world.service_tick_count();
    step.status = status.to_owned();
    step.expected_errors = expected_errors;
    step.unexpected_errors = unexpected_errors;
    step.failure_message = failure_message;
}

fn tx_error_counts(tx_log: &[TxOutcome], start: usize, end: usize) -> (u64, u64) {
    let mut expected_errors = 0u64;
    let mut unexpected_errors = 0u64;
    for outcome in tx_log.iter().take(end).skip(start) {
        if outcome.ok {
            continue;
        }
        if outcome.expected_error {
            expected_errors = expected_errors.saturating_add(1);
        } else {
            unexpected_errors = unexpected_errors.saturating_add(1);
        }
    }
    (expected_errors, unexpected_errors)
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
    /// Sweep a single named parameter as `name=v1,v2,...`. When set, the runner
    /// runs one iteration per (value, seed replicate) and records each value as
    /// the iteration's risk-surface coordinate. Overrides `--iterations`.
    #[arg(long = "sweep")]
    sweep: Option<String>,
    /// Seed replicates per swept value (default 1). Only used with `--sweep`.
    #[arg(long = "seeds-per-value", default_value_t = 1)]
    seeds_per_value: u64,
}

impl RunnerArgs {
    fn try_into_config(self) -> Result<RunnerConfig> {
        let sweep = match self.sweep {
            Some(spec) => Some(parse_sweep_spec(&spec, self.seeds_per_value)?),
            None => None,
        };
        Ok(RunnerConfig {
            iterations: self.iterations,
            flows_per_iteration: self.flows_per_iteration,
            seed: match self.seed {
                Some(seed) => seed_from_hex(&seed)?,
                None => RunnerConfig::default().seed,
            },
            debug: self.debug,
            out_dir: self.out_dir,
            sweep,
        })
    }
}

/// Parse `name=v1,v2,...` into a `SweepConfig`. Values are finite f64. The
/// declared order is preserved (it is the canonical axis order downstream).
fn parse_sweep_spec(spec: &str, seeds_per_value: u64) -> Result<SweepConfig> {
    let (name, values) = spec
        .split_once('=')
        .ok_or_else(|| anyhow!("--sweep must be `name=v1,v2,...`, got {spec:?}"))?;
    let name = name.trim();
    if name.is_empty() {
        anyhow::bail!("--sweep parameter name must be non-empty in {spec:?}");
    }
    let values = values
        .split(',')
        .map(|raw| raw.trim())
        .filter(|raw| !raw.is_empty())
        .map(|raw| {
            raw.parse::<f64>()
                .map_err(|_| anyhow!("--sweep value {raw:?} is not a number"))
                .and_then(|value| {
                    if value.is_finite() {
                        Ok(value)
                    } else {
                        Err(anyhow!("--sweep value {raw:?} must be finite"))
                    }
                })
        })
        .collect::<Result<Vec<f64>>>()?;
    if values.is_empty() {
        anyhow::bail!("--sweep must declare at least one value in {spec:?}");
    }
    if seeds_per_value == 0 {
        anyhow::bail!("--seeds-per-value must be at least 1");
    }
    Ok(SweepConfig {
        name: name.to_owned(),
        values,
        seeds_per_value,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::riptide_sim;
    use serde_json::Value;
    use solana_account::Account;
    use solana_system_interface::instruction::transfer;

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
        assert_eq!(value["trace_schema_version"], 1);
        assert_eq!(value["status"], "passed");
        assert_eq!(value["totals"]["iterations"], 2);
        assert_eq!(value["totals"]["flows"], 6);
        assert_eq!(value["iterations"][0]["flow_counts"]["only_flow"], 3);
        assert!(value["iterations"][0]["first_failing_flow_step"].is_null());
        assert!(value["iterations"][0]["first_failure"].is_null());
        let trace = value["iterations"][0]["flow_trace"].as_array().unwrap();
        assert_eq!(trace.len(), 3);
        assert_eq!(trace[0]["step_index"], 0);
        assert_eq!(trace[0]["flow_index"], 0);
        assert_eq!(trace[0]["flow_name"], "only_flow");
        assert_eq!(trace[0]["tx_log_start"], 0);
        assert_eq!(trace[0]["tx_log_end"], 0);
        assert_eq!(trace[0]["service_ticks_before"], 0);
        assert_eq!(trace[0]["service_ticks_after"], 0);
        assert_eq!(trace[0]["status"], "passed");
        assert_eq!(trace[0]["expected_errors"], 0);
        assert_eq!(trace[0]["unexpected_errors"], 0);
        assert!(trace[0]["failure_message"].is_null());

        // Additive sweep fields are omitted when empty so non-sweep artifacts
        // serialize byte-identically (trace_schema_version stays 1).
        let iteration0 = value["iterations"][0].as_object().unwrap();
        assert!(!iteration0.contains_key("parameters"));
        assert!(!iteration0.contains_key("metrics"));
        assert!(!iteration0.contains_key("invariant_fires"));

        let _ = fs::remove_dir_all(out_dir);
    }

    #[derive(Default)]
    struct SweepSim {
        world: World,
    }

    #[riptide_sim]
    impl SweepSim {
        #[init]
        fn init(&mut self) {}

        #[flow(weight = 100)]
        fn record_shock(&mut self) -> Result<()> {
            // Read the injected sweep coordinate and turn it into recorded
            // outcome signal: high shock => an error-severity invariant fire.
            let shock = self.world.sweep_value("rate_shock_bps").unwrap_or(0.0);
            self.world.record_metric("bad_debt", shock * 2.0);
            if shock >= 300.0 {
                self.world.record_invariant_fire("solvency");
            }
            Ok(())
        }

        #[end]
        fn end(&mut self) -> Result<()> {
            Ok(())
        }
    }

    #[test]
    fn runner_sweep_populates_every_cell() {
        let out_dir = unique_temp_dir();
        let config = RunnerConfig {
            flows_per_iteration: 1,
            out_dir: Some(out_dir.clone()),
            sweep: Some(SweepConfig {
                name: "rate_shock_bps".to_owned(),
                values: vec![0.0, 100.0, 300.0, 500.0],
                seeds_per_value: 3,
            }),
            ..RunnerConfig::default()
        };

        SimulationRunner::<SweepSim>::new(config).run().unwrap();

        let raw = fs::read_to_string(out_dir.join("guided-sim-run.json")).unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        // 4 values x 3 seeds = 12 iterations, all retained (no break on fail).
        assert_eq!(value["totals"]["iterations"], 12);
        assert_eq!(value["status"], "passed");
        let iterations = value["iterations"].as_array().unwrap();
        assert_eq!(iterations.len(), 12);
        // Each iteration carries the active swept coordinate.
        assert_eq!(iterations[0]["parameters"]["rate_shock_bps"], 0.0);
        assert_eq!(iterations[3]["parameters"]["rate_shock_bps"], 100.0);
        assert_eq!(iterations[6]["parameters"]["rate_shock_bps"], 300.0);
        assert_eq!(iterations[11]["parameters"]["rate_shock_bps"], 500.0);
        // Recorded metric scales with the coordinate.
        assert_eq!(iterations[6]["metrics"]["bad_debt"], 600.0);
        // High-shock cells record the solvency invariant fire; low-shock don't.
        // This is surface-level economic failure signal, distinct from an
        // engine error: the iteration still runs to completion ("passed").
        assert_eq!(iterations[6]["invariant_fires"][0], "solvency");
        assert_eq!(iterations[6]["status"], "passed");
        assert!(iterations[0].as_object().unwrap().get("invariant_fires").is_none());

        let _ = fs::remove_dir_all(out_dir);
    }

    struct NoopService;

    impl crate::Service for NoopService {
        fn tick(&mut self, _world: &mut World) {}
    }

    #[derive(Default)]
    struct ServiceTickSim {
        world: World,
    }

    #[riptide_sim]
    impl ServiceTickSim {
        #[init]
        fn init(&mut self) {
            self.world.add_service(NoopService);
        }

        #[flow(weight = 100)]
        fn step(&mut self) {}

        #[end]
        fn end(&mut self) {}
    }

    #[test]
    fn runner_trace_records_service_tick_offsets() {
        let out_dir = unique_temp_dir();
        let config = RunnerConfig {
            flows_per_iteration: 2,
            out_dir: Some(out_dir.clone()),
            ..RunnerConfig::default()
        };

        SimulationRunner::<ServiceTickSim>::new(config)
            .run()
            .unwrap();

        let raw = fs::read_to_string(out_dir.join("guided-sim-run.json")).unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        let trace = value["iterations"][0]["flow_trace"].as_array().unwrap();
        assert_eq!(trace[0]["service_ticks_before"], 0);
        assert_eq!(trace[0]["service_ticks_after"], 1);
        assert_eq!(trace[1]["service_ticks_before"], 1);
        assert_eq!(trace[1]["service_ticks_after"], 2);
        assert_eq!(value["iterations"][0]["service_ticks"], 2);

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
        let trace = value["iterations"][0]["flow_trace"].as_array().unwrap();
        assert_eq!(trace.len(), 1);
        assert_eq!(trace[0]["step_index"], 0);
        assert_eq!(trace[0]["flow_index"], 0);
        assert_eq!(trace[0]["flow_name"], "failing_flow");
        assert_eq!(trace[0]["status"], "returned_error");
        assert_eq!(trace[0]["tx_log_start"], 0);
        assert_eq!(trace[0]["tx_log_end"], 0);
        assert_eq!(trace[0]["service_ticks_before"], 0);
        assert_eq!(trace[0]["service_ticks_after"], 0);
        assert!(trace[0]["failure_message"]
            .as_str()
            .unwrap()
            .contains("intentional flow failure"));
        assert_eq!(value["iterations"][0]["first_failing_flow_step"], trace[0]);
        assert_eq!(value["iterations"][0]["first_failure"]["stage"], "flow");
        assert_eq!(
            value["iterations"][0]["first_failure"]["status"],
            "returned_error"
        );
        assert_eq!(value["iterations"][0]["first_failure"]["step_index"], 0);
        assert_eq!(value["iterations"][0]["first_failure"]["flow_index"], 0);
        assert_eq!(
            value["iterations"][0]["first_failure"]["flow_name"],
            "failing_flow"
        );

        let _ = fs::remove_dir_all(out_dir);
    }

    #[derive(Default)]
    struct ReplayTraceSim {
        world: World,
        fragile_hits: u64,
    }

    #[riptide_sim]
    impl ReplayTraceSim {
        #[init]
        fn init(&mut self) {
            self.fragile_hits = 0;
        }

        #[flow(weight = 0)]
        fn skipped(&mut self) {}

        #[flow(weight = 100)]
        fn fragile(&mut self) -> Result<()> {
            self.fragile_hits = self.fragile_hits.saturating_add(1);
            anyhow::ensure!(
                self.fragile_hits < 2,
                "fragile replay failure on second hit"
            );
            Ok(())
        }

        #[end]
        fn end(&mut self) {}
    }

    #[test]
    fn runner_replay_sequence_preserves_traced_counts_and_failure_step() {
        let original_dir = unique_temp_dir();
        let original_config = RunnerConfig {
            flows_per_iteration: 3,
            out_dir: Some(original_dir.clone()),
            ..RunnerConfig::default()
        };

        let original_error = SimulationRunner::<ReplayTraceSim>::new(original_config)
            .run()
            .unwrap_err()
            .to_string();
        assert!(original_error.contains("fragile replay failure on second hit"));

        let original_raw = fs::read_to_string(original_dir.join("guided-sim-run.json")).unwrap();
        let original_value: Value = serde_json::from_str(&original_raw).unwrap();
        let original_trace = original_value["iterations"][0]["flow_trace"]
            .as_array()
            .unwrap();
        let replay_sequence = original_trace
            .iter()
            .map(|step| step["flow_index"].as_u64().unwrap() as usize)
            .collect::<Vec<_>>();
        assert_eq!(replay_sequence, vec![1, 1]);

        let replay_dir = unique_temp_dir();
        let replay_config = RunnerConfig {
            flows_per_iteration: replay_sequence.len() as u64,
            out_dir: Some(replay_dir.clone()),
            ..RunnerConfig::default()
        };
        let replay_error = SimulationRunner::<ReplayTraceSim>::new_with_replay_flow_sequence(
            replay_config,
            replay_sequence,
        )
        .run()
        .unwrap_err()
        .to_string();
        assert!(replay_error.contains("fragile replay failure on second hit"));

        let replay_raw = fs::read_to_string(replay_dir.join("guided-sim-run.json")).unwrap();
        let replay_value: Value = serde_json::from_str(&replay_raw).unwrap();
        assert_eq!(
            replay_value["iterations"][0]["flow_counts"],
            original_value["iterations"][0]["flow_counts"]
        );
        assert_eq!(
            replay_value["iterations"][0]["first_failing_flow_step"],
            original_value["iterations"][0]["first_failing_flow_step"]
        );

        let _ = fs::remove_dir_all(original_dir);
        let _ = fs::remove_dir_all(replay_dir);
    }

    #[test]
    fn runner_replay_rejects_bad_flow_index() {
        let out_dir = unique_temp_dir();
        let config = RunnerConfig {
            out_dir: Some(out_dir.clone()),
            ..RunnerConfig::default()
        };

        let error = SimulationRunner::<CounterSim>::new_with_replay_flow_sequence(config, vec![1])
            .run()
            .unwrap_err()
            .to_string();
        assert!(error.contains("replay flow index 1 at step 0 is out of range"));

        let raw = fs::read_to_string(out_dir.join("guided-sim-run.json")).unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        let first_failure = &value["iterations"][0]["first_failure"];
        assert_eq!(first_failure["stage"], "flow_selection");
        assert_eq!(first_failure["status"], "returned_error");
        assert_eq!(first_failure["step_index"], 0);
        assert!(first_failure["failure_message"]
            .as_str()
            .unwrap()
            .contains("replay flow index 1 at step 0 is out of range"));

        let _ = fs::remove_dir_all(out_dir);
    }

    #[derive(Default)]
    struct ExpectedErrorSim {
        world: World,
    }

    #[riptide_sim]
    impl ExpectedErrorSim {
        #[init]
        fn init(&mut self) {}

        #[flow(weight = 100)]
        fn expected_error_flow(&mut self) -> Result<()> {
            let recipient = Pubkey::new_from_array([12; 32]);
            let ix = transfer(&self.world.admin_pubkey(), &recipient, u64::MAX);
            self.world
                .process_transaction_expect_error(&[ix], Some("too_large_transfer"))?;
            Ok(())
        }

        #[end]
        fn end(&mut self) {}
    }

    #[test]
    fn runner_trace_summarizes_expected_error_outcomes() {
        let out_dir = unique_temp_dir();
        let config = RunnerConfig {
            out_dir: Some(out_dir.clone()),
            ..RunnerConfig::default()
        };

        SimulationRunner::<ExpectedErrorSim>::new(config)
            .run()
            .unwrap();

        let raw = fs::read_to_string(out_dir.join("guided-sim-run.json")).unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        let trace = &value["iterations"][0]["flow_trace"][0];
        assert_eq!(trace["status"], "passed");
        assert_eq!(trace["tx_log_start"], 0);
        assert_eq!(trace["tx_log_end"], 1);
        assert_eq!(trace["expected_errors"], 1);
        assert_eq!(trace["unexpected_errors"], 0);
        assert!(value["iterations"][0]["first_failing_flow_step"].is_null());
        assert!(value["iterations"][0]["first_failure"].is_null());

        let _ = fs::remove_dir_all(out_dir);
    }

    #[derive(Default)]
    struct PanickingSim {
        world: World,
    }

    #[riptide_sim]
    impl PanickingSim {
        #[init]
        fn init(&mut self) {}

        #[flow(weight = 100)]
        fn panicking_flow(&mut self) {
            panic!("intentional flow panic");
        }

        #[end]
        fn end(&mut self) {}
    }

    #[test]
    fn runner_trace_records_first_failing_step_for_panic() {
        let out_dir = unique_temp_dir();
        let config = RunnerConfig {
            out_dir: Some(out_dir.clone()),
            ..RunnerConfig::default()
        };

        let error = SimulationRunner::<PanickingSim>::new(config)
            .run()
            .unwrap_err()
            .to_string();
        assert!(error.contains("simulation panicked: intentional flow panic"));

        let raw = fs::read_to_string(out_dir.join("guided-sim-run.json")).unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["status"], "failed");
        assert_eq!(value["totals"]["panics"], 1);
        assert_eq!(value["iterations"][0]["status"], "panic");
        assert_eq!(value["iterations"][0]["panic"], true);
        let trace = value["iterations"][0]["flow_trace"].as_array().unwrap();
        assert_eq!(trace.len(), 1);
        assert_eq!(trace[0]["flow_name"], "panicking_flow");
        assert_eq!(trace[0]["status"], "panic");
        assert!(trace[0]["failure_message"]
            .as_str()
            .unwrap()
            .contains("intentional flow panic"));
        assert_eq!(value["iterations"][0]["first_failing_flow_step"], trace[0]);
        assert_eq!(value["iterations"][0]["first_failure"]["stage"], "flow");
        assert_eq!(value["iterations"][0]["first_failure"]["status"], "panic");
        assert_eq!(
            value["iterations"][0]["first_failure"]["failure_message"],
            trace[0]["failure_message"]
        );

        let _ = fs::remove_dir_all(out_dir);
    }

    #[derive(Default)]
    struct EndFailingSim {
        world: World,
    }

    #[riptide_sim]
    impl EndFailingSim {
        #[init]
        fn init(&mut self) {}

        #[flow(weight = 100)]
        fn passing_flow(&mut self) {}

        #[end]
        fn end(&mut self) -> Result<()> {
            anyhow::bail!("intentional end failure")
        }
    }

    #[test]
    fn runner_trace_records_first_failure_for_end_error() {
        let out_dir = unique_temp_dir();
        let config = RunnerConfig {
            out_dir: Some(out_dir.clone()),
            ..RunnerConfig::default()
        };

        let error = SimulationRunner::<EndFailingSim>::new(config)
            .run()
            .unwrap_err()
            .to_string();
        assert!(error.contains("intentional end failure"));

        let raw = fs::read_to_string(out_dir.join("guided-sim-run.json")).unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["status"], "failed");
        assert_eq!(value["iterations"][0]["flow_trace"][0]["status"], "passed");
        assert!(value["iterations"][0]["first_failing_flow_step"].is_null());
        let first_failure = &value["iterations"][0]["first_failure"];
        assert_eq!(first_failure["stage"], "end");
        assert_eq!(first_failure["status"], "returned_error");
        assert!(first_failure["step_index"].is_null());
        assert!(first_failure["flow_index"].is_null());
        assert!(first_failure["flow_name"].is_null());
        assert!(first_failure["failure_message"]
            .as_str()
            .unwrap()
            .contains("intentional end failure"));

        let _ = fs::remove_dir_all(out_dir);
    }

    #[derive(Default)]
    struct EndPanickingSim {
        world: World,
    }

    #[riptide_sim]
    impl EndPanickingSim {
        #[init]
        fn init(&mut self) {}

        #[flow(weight = 100)]
        fn passing_flow(&mut self) {}

        #[end]
        fn end(&mut self) {
            panic!("intentional end panic");
        }
    }

    #[test]
    fn runner_trace_records_first_failure_for_end_panic() {
        let out_dir = unique_temp_dir();
        let config = RunnerConfig {
            out_dir: Some(out_dir.clone()),
            ..RunnerConfig::default()
        };

        let error = SimulationRunner::<EndPanickingSim>::new(config)
            .run()
            .unwrap_err()
            .to_string();
        assert!(error.contains("simulation panicked: intentional end panic"));

        let raw = fs::read_to_string(out_dir.join("guided-sim-run.json")).unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["status"], "failed");
        assert_eq!(value["iterations"][0]["status"], "panic");
        assert_eq!(value["iterations"][0]["flow_trace"][0]["status"], "passed");
        assert!(value["iterations"][0]["first_failing_flow_step"].is_null());
        let first_failure = &value["iterations"][0]["first_failure"];
        assert_eq!(first_failure["stage"], "end");
        assert_eq!(first_failure["status"], "panic");
        assert!(first_failure["failure_message"]
            .as_str()
            .unwrap()
            .contains("intentional end panic"));

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
        assert_eq!(value["iterations"][0]["flow_trace"][0]["status"], "passed");
        assert!(value["iterations"][0]["first_failing_flow_step"].is_null());
        let first_failure = &value["iterations"][0]["first_failure"];
        assert_eq!(first_failure["stage"], "regression");
        assert_eq!(first_failure["status"], "returned_error");
        assert!(first_failure["failure_message"]
            .as_str()
            .unwrap()
            .contains("regression hash mismatch"));

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
