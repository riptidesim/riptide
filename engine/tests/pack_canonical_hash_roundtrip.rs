//! Canonical-hash round-trip invariant.
//!
//! The pack's canonical_hash surface must be stable across
//! serialize-only and serialize-then-reparse paths. The CLI writes
//! the SimulationResult to disk, re-reads it, and hands it to the
//! engine's `pack` subcommand; if any field loses fidelity across
//! that round-trip, the pack hash drifts from the in-memory hash and
//! Sprint 11's pinned `d04feab9…` is no longer the same string a
//! reviewer sees in `manifest.json`. This test catches it.

#![cfg(feature = "litesvm-backend")]
#![cfg(not(doctest))]

use std::path::{Path, PathBuf};

use riptide_engine::{
    pack::canonical_hash,
    replay::{load_replay_config, run_multi_replay, MultiComponentHarness, ReplayConfigShape},
    types::SimulationResult,
};

fn monorepo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("engine crate has a parent directory")
        .to_path_buf()
}

fn required_artifacts() -> Vec<(PathBuf, &'static str)> {
    let repo = monorepo_root();
    vec![
        (
            repo.join("programs/liquid-staking/target/deploy/liquid_staking.so"),
            "liquid_staking.so",
        ),
        (
            repo.join("programs/admin_mock_oracle/target/deploy/admin_mock_oracle.so"),
            "admin_mock_oracle.so",
        ),
        (
            repo.join("programs/admin_mock_oracle/target/deploy/admin_mock_oracle-keypair.json"),
            "admin_mock_oracle-keypair.json",
        ),
        (
            repo.join("programs/lending_pool/target/deploy/lending_pool.so"),
            "lending_pool.so",
        ),
    ]
}

fn skip_if_missing(path: &Path, label: &str) -> bool {
    if !path.exists() {
        if std::env::var("CI").map(|v| !v.is_empty()).unwrap_or(false) {
            panic!("CI missing artifact: {}", path.display());
        }
        eprintln!("skipping: {label} missing at {}", path.display());
        true
    } else {
        false
    }
}

#[test]
fn canonical_hash_survives_serde_roundtrip() {
    for (path, label) in required_artifacts() {
        if skip_if_missing(&path, label) {
            return;
        }
    }
    let fixture = monorepo_root()
        .join("fixtures/replays/lst-lending-contagion-proof");
    let shape = load_replay_config(&fixture.join("config.json"))
        .expect("load multi-component contagion config");
    let cfg = match shape {
        ReplayConfigShape::Multi(cfg) => cfg,
        ReplayConfigShape::Legacy(_) => panic!("expected multi-component"),
    };
    let mut harness = MultiComponentHarness::bootstrap(&cfg, &fixture)
        .expect("bootstrap multi-component harness");
    let mut result = run_multi_replay(&mut harness, "__canonical__".into())
        .expect("run multi-component replay");
    // Simulate the CLI rewrite: output_path gets replaced with the
    // scenario's resolved artifact path before the JSON lands on
    // disk. canonical_hash must be robust against that rewrite.
    result.run_config.output_path =
        "/tmp/absolute/path/that/definitely/changes/across/invocations/simulation-result.json"
            .to_string();

    let hash_in_memory = canonical_hash(&result);

    // Round-trip through JSON.
    let json = serde_json::to_string_pretty(&result).unwrap();
    let parsed: SimulationResult = serde_json::from_str(&json).unwrap();
    let hash_after_roundtrip = canonical_hash(&parsed);

    assert_eq!(
        hash_in_memory, hash_after_roundtrip,
        "canonical_hash drifted across serde_json round-trip — pack surfaces would disagree with the in-memory hash"
    );

    // And both must match the pinned Sprint 11 contagion hash so the
    // CLI-written pack and the in-memory test path report the same
    // number to reviewers.
    assert_eq!(
        hash_in_memory,
        "d04feab99390d63de6625bad4994a05e89cede359b4599431e815fe327cd0aeb",
        "canonical hash drifted from Sprint 11 pin",
    );
}
