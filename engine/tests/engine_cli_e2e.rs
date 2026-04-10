//! End-to-end smoke test for the `riptide-engine` binary against a live
//! solana-test-validator.
//!
//! This test is gated on both `#[ignore]` AND the `RIPTIDE_E2E` env var so
//! that `cargo test` NEVER runs it by accident. To run it:
//!
//! ```bash
//! # terminal 1
//! solana-test-validator
//!
//! # terminal 2
//! cargo build --release -p riptide-engine
//! cargo build-sbf --manifest-path programs/lending_pool/Cargo.toml
//! RIPTIDE_E2E=1 RIPTIDE_PAYER=~/.config/solana/id.json \
//!   cargo test -p riptide-engine --test engine_cli_e2e -- --ignored --nocapture
//! ```
//!
//! The test runs the release binary against the running validator with the
//! shipped sample fixtures and asserts the output JSON deserializes back
//! into a `SimulationResult`.

#![cfg(not(doctest))]

use std::{path::PathBuf, process::Command};

#[test]
#[ignore = "requires RIPTIDE_E2E=1 and a running solana-test-validator"]
fn engine_cli_produces_valid_simulation_result() {
    if std::env::var("RIPTIDE_E2E").ok().as_deref() != Some("1") {
        eprintln!("skipping: set RIPTIDE_E2E=1 to run");
        return;
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let monorepo = manifest_dir.parent().unwrap();
    let binary = monorepo.join("target/release/riptide-engine");
    assert!(
        binary.exists(),
        "release binary missing at {}; run `cargo build --release -p riptide-engine` first",
        binary.display()
    );

    let config = monorepo.join("fixtures/run-config.sample.json");
    // Use the multi-persona fixture so the strict persona-validation path
    // (added in the post-T09 cleanup) is exercised end-to-end. The singular
    // policy.sample.json only contains cautious-yield-farmer and would now
    // be rejected by build_agent_personas because run-config asks for
    // panic-whale too.
    let policies = monorepo.join("fixtures/policies.sample.json");
    let output = std::env::temp_dir().join("riptide-e2e-out.json");
    let _ = std::fs::remove_file(&output);

    // The CLI now requires --payer (no default-wallet fallback). The test
    // honors RIPTIDE_PAYER from the environment so the operator chooses
    // which keypair to spend SOL from. fixtures/run-config.sample.json's
    // validator_url is loopback, so --allow-nonlocal-rpc is intentionally
    // NOT passed: a regression that flips it to a public RPC must fail
    // closed.
    let payer = std::env::var("RIPTIDE_PAYER")
        .expect("set RIPTIDE_PAYER to the path of a disposable local validator keypair");

    let status = Command::new(&binary)
        .arg("--config")
        .arg(&config)
        .arg("--policies")
        .arg(&policies)
        .arg("--output")
        .arg(&output)
        .arg("--payer")
        .arg(&payer)
        .status()
        .expect("spawn riptide-engine");
    assert!(status.success(), "riptide-engine exited non-zero: {status:?}");

    let raw = std::fs::read_to_string(&output).expect("read output");
    let result: riptide_engine::types::SimulationResult =
        serde_json::from_str(&raw).expect("output deserializes into SimulationResult");
    assert_eq!(result.total_ticks, result.run_config.ticks);
    assert!(!result.timeseries.is_empty());
}
