//! LiteSVM benchmark — measures wall-clock time for a full simulation run
//! using the in-process LiteSVM backend.
//!
//! This is the LiteSVM benchmark that replaces the validator-backed
//! `benchmark.rs` as the primary performance measurement path.
//!
//! ## Usage
//!
//! ```bash
//! cargo build-sbf --manifest-path programs/lending_pool/Cargo.toml
//! cargo run --release -p riptide-engine --features litesvm-backend \
//! --example litesvm_benchmark
//! ```
//!
//! Override workload with env vars:
//!
//! ```bash
//! BENCH_AGENTS=100 BENCH_TICKS=180 cargo run --release -p riptide-engine \
//! --features litesvm-backend --example litesvm_benchmark
//! ```
//!
//! ## Comparison baseline
//!
//! The warm-validator baseline for 100 agents × 180 ticks was 901.461s
//! (measured 2026-04-11 on `solana-test-validator` with `--bpf-program`
//! preload + `--skip-deploy`).

use std::collections::BTreeMap;
use std::time::Instant;

use riptide_engine::{
    agent::policy::LENDING_RUNTIME_ACTIONS,
    harness::setup::default_program_so_path,
    scenario::BaselineScenario,
    sim::{
        build_agent_personas,
        litesvm::LiteSvmBootstrapConfig,
        run_simulation, LiteSvmHarness, SimulationParams,
    },
    types::{
        Policy, PositionSizing, PositionSizingStrategy,
        RunConfig, Trigger, TriggerCondition,
    },
};

fn main() {
    let agent_count: u32 = std::env::var("BENCH_AGENTS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(100);
    let tick_count: u32 = std::env::var("BENCH_TICKS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(180);

    let so_path = default_program_so_path();
    if !so_path.exists() {
        eprintln!(
            "error: lending_pool.so not found at {}\n\
             run: cargo build-sbf --manifest-path programs/lending_pool/Cargo.toml",
            so_path.display()
        );
        std::process::exit(1);
    }

    eprintln!("=== LiteSVM Benchmark ===");
    eprintln!("agents={agent_count} ticks={tick_count}");
    eprintln!("program_so={}", so_path.display());

    // --- Bootstrap ---
    let t_bootstrap = Instant::now();
    let bootstrap_config = LiteSvmBootstrapConfig {
        program_so: so_path,
        agent_count: agent_count as usize,
        starting_price: 100,
        price_exponent: 0,
        pool_config: riptide_engine::harness::lending::LendingPoolConfig {
            ltv_bps: 7_000,
            liquidation_threshold_bps: 8_000,
            liquidation_bonus_bps: 500,
            interest_bps: 250,
            deposit_limit: u64::MAX / 4,
            borrow_limit: u64::MAX / 4,
        },
        seed_deposit: 100,
        adapter: None,
    };
    let mut harness = LiteSvmHarness::bootstrap(bootstrap_config)
        .expect("LiteSVM bootstrap failed");
    let bootstrap_elapsed = t_bootstrap.elapsed();
    eprintln!("bootstrap={:.3}s", bootstrap_elapsed.as_secs_f64());

    // --- Build scenario + policy ---
    let policy = Policy {
        persona_id: "steady-lp".into(),
        persona_label: "steady-lp".into(),
        action_rate_multiplier: 1.0,
        risk_tolerance: 0.5,
        action_weights: BTreeMap::from([
            ("deposit".into(), 0.6),
            ("borrow".into(), 0.15),
            ("withdraw".into(), 0.1),
            ("repay".into(), 0.1),
            ("liquidate".into(), 0.05),
        ]),
        triggers: vec![Trigger {
            condition: TriggerCondition::PriceDropPercent { threshold: 0.9 },
            response: "hold".into(),
            severity: 1,
            cooldown_ticks: 1,
            weight_boost: None,
        }],
        position_sizing: PositionSizing {
            strategy: PositionSizingStrategy::Fixed,
            params: BTreeMap::from([("amount".into(), 50.0)]),
        },
        max_exposure: 0.8,
        persona_args: BTreeMap::new(),
    };

    let run_config = RunConfig {
        agents: agent_count,
        ticks: tick_count,
        scenario: "baseline".into(),
        seed: 42,
        personas: vec!["steady-lp".into()],
        validator_url: "unused".into(),
        output_path: "unused".into(),
    };

    let policies = vec![policy];
    let agent_personas = build_agent_personas(
        &run_config.personas,
        &policies,
        agent_count as usize,
    )
    .expect("build_agent_personas failed");

    let mut scenario = BaselineScenario::new(100.0, 25);
    let params = SimulationParams {
        run_config: &run_config,
        policies,
        agent_personas,
        available_actions: LENDING_RUNTIME_ACTIONS.to_vec(),
        starting_balance: 20_000.0,
        starting_price: 100.0,
        simulation_boundaries: vec!["LiteSVM benchmark run".into()],
        invariants: Vec::new(),
        scheduled_actions: Vec::new(),
        semantics: None,
    };

    // --- Run simulation ---
    let t_sim = Instant::now();
    let result = run_simulation(&mut harness, &mut scenario, params)
        .expect("run_simulation failed");
    let sim_elapsed = t_sim.elapsed();
    let total_elapsed = t_bootstrap.elapsed();

    // --- Report ---
    eprintln!();
    eprintln!("=== Results ===");
    eprintln!("agents={agent_count}");
    eprintln!("ticks={tick_count}");
    eprintln!("total_events={}", result.events.len());
    eprintln!("bootstrap_secs={:.3}", bootstrap_elapsed.as_secs_f64());
    eprintln!("simulation_secs={:.3}", sim_elapsed.as_secs_f64());
    eprintln!("total_secs={:.3}", total_elapsed.as_secs_f64());
    eprintln!();
    eprintln!("warm_validator_baseline_secs=901.461");
    let speedup = 901.461 / total_elapsed.as_secs_f64();
    eprintln!("speedup_vs_validator={speedup:.1}x");
}
