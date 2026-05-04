// Adapted from Trident (MIT) — https://github.com/Ackee-Blockchain/trident

use std::{any::Any, process::ExitCode};

use anyhow::{anyhow, Result};
use clap::Parser;

use crate::{rng::seed_from_hex, World};

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
}

impl Default for RunnerConfig {
    fn default() -> Self {
        Self {
            iterations: 1,
            flows_per_iteration: 1,
            seed: [0x52; 32],
            debug: false,
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
        for iteration in 0..self.config.iterations {
            let seed = iteration_seed(self.config.seed, iteration);
            eprintln!(
                "riptide sim iteration={} seed={}",
                iteration,
                crate::rng::seed_to_hex(&seed)
            );
            let result = self.run_iteration(seed);
            if let Err(error) = result {
                eprintln!(
                    "riptide sim failure iteration={} seed={}",
                    iteration,
                    crate::rng::seed_to_hex(&seed)
                );
                return Err(error);
            }
        }
        Ok(())
    }

    fn run_iteration(&self, seed: [u8; 32]) -> Result<()> {
        let mut simulation = T::default();
        simulation.world().set_rng_seed(seed);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            simulation.__riptide_init()?;
            for _ in 0..self.config.flows_per_iteration {
                let idx = pick_flow(T::__riptide_flow_table(), simulation.world())?;
                simulation.__riptide_dispatch_flow(idx)?;
                simulation.world().tick_services();
            }
            simulation.__riptide_end()
        }));

        match result {
            Ok(Ok(())) => {
                if self.config.debug {
                    dump_tx_log(simulation.world());
                }
                Ok(())
            }
            Ok(Err(error)) => {
                dump_tx_log(simulation.world());
                Err(error)
            }
            Err(payload) => {
                dump_tx_log(simulation.world());
                Err(anyhow!("simulation panicked: {}", panic_message(&payload)))
            }
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
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::riptide_sim;

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
}
