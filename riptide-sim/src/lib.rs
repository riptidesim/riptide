//! Guided Rust simulation API for project-owned Riptide flows.

extern crate self as riptide_sim;

pub mod accounts;
pub mod bootstrap;
pub mod rng;
pub mod runner;
pub mod services;
pub mod spl;
pub mod world;

pub use accounts::AddressStorage;
pub use bootstrap::{
    BootstrapReport, CoverageConfig, ForkSnapshotReport, MetricsConfig, RegressionConfig,
    SimBootstrap, SimManifest,
};
pub use rng::RiptideRng;
pub use runner::{run, FlowSpec, IntoSimResult, RiptideSimulation, RunnerConfig, SimulationRunner};
pub use services::Service;
pub use spl::{spl_mint_data, spl_token_2022_mint_data, spl_token_account_data};
pub use world::{TxOutcome, World};

pub use anyhow;
pub use borsh;
pub use riptide_sim_macros::*;
pub use solana_account;
pub use solana_sdk;
pub use solana_transaction;
