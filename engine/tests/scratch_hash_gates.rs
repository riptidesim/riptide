//! Cargo entry points for the byte-stable AMM/perps scratch gates.
//!
//! The shell scripts own the fixture construction. These tests make the
//! Sprint 5/6 hash gates addressable via the close-note cargo filters.

#![cfg(not(doctest))]

use std::{path::PathBuf, process::Command};

fn monorepo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("engine crate has a monorepo parent")
        .to_path_buf()
}

fn run_script(script: &str, expected_hash: &str) {
    let repo = monorepo_root();
    let script_path = repo.join("scripts").join(script);
    let engine_bin = PathBuf::from(env!("CARGO_BIN_EXE_riptide-engine"));

    let output = Command::new("bash")
        .arg(&script_path)
        .env("RIPTIDE_ENGINE_BIN", &engine_bin)
        .current_dir(&repo)
        .output()
        .unwrap_or_else(|err| panic!("spawn {}: {err}", script_path.display()));

    print!("{}", String::from_utf8_lossy(&output.stdout));
    eprint!("{}", String::from_utf8_lossy(&output.stderr));

    assert!(
        output.status.success(),
        "{} exited with {}",
        script_path.display(),
        output.status
    );

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains(expected_hash),
        "{} did not print expected hash {expected_hash}; stdout:\n{stdout}",
        script_path.display()
    );
}

#[test]
fn perps_scratch() {
    run_script(
        "perpetuals-scratch.sh",
        "1518bcfdeb6cdb7d538be86584195b4b348b73beed610003d4a35939994f1878",
    );
}

#[test]
fn amm_scratch() {
    run_script(
        "amm-scratch.sh",
        "5de060cdcacfbacaa598a387a9f249e7633fedac449f137d62c0ede9cf10624f",
    );
}
