//! End-to-end smoke test for the `riptide-engine` binary using the
//! in-process LiteSVM backend.
//!
//! This test is gated on `#[ignore]` so that `cargo test` does not run it
//! by default (it needs the release binary pre-built). To run:
//!
//! ```bash
//! cargo build --release -p riptide-engine
//! cargo build-sbf --manifest-path programs/lending_pool/Cargo.toml
//! RIPTIDE_E2E=1 cargo test -p riptide-engine --test engine_cli_e2e -- --ignored --nocapture
//! ```
//!
//! The test runs the release binary against the LiteSVM backend with the
//! shipped sample fixtures and asserts the output JSON deserializes back
//! into a `SimulationResult`.

#![cfg(not(doctest))]

use std::{path::PathBuf, process::Command};

#[test]
#[ignore = "requires RIPTIDE_E2E=1 and a pre-built release binary + lending_pool.so"]
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
    let policies = monorepo.join("fixtures/policies.sample.json");
    let output = std::env::temp_dir().join("riptide-e2e-out.json");
    let _ = std::fs::remove_file(&output);

    // The LiteSVM binary only needs --config, --policies, and --output.
    // No --payer or live validator required.
    let status = Command::new(&binary)
        .arg("--config")
        .arg(&config)
        .arg("--policies")
        .arg(&policies)
        .arg("--output")
        .arg(&output)
        .status()
        .expect("spawn riptide-engine");
    assert!(
        status.success(),
        "riptide-engine exited non-zero: {status:?}"
    );

    let raw = std::fs::read_to_string(&output).expect("read output");
    let result: riptide_engine::types::SimulationResult =
        serde_json::from_str(&raw).expect("output deserializes into SimulationResult");
    assert_eq!(result.total_ticks, result.run_config.ticks);
    assert!(!result.timeseries.is_empty());
}
