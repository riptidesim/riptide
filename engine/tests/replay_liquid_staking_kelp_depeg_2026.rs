//! Liquid-staking Kelp-style depeg + withdrawal-run replay gate.
//!
//! Locks five things on the `liquid-staking-kelp-depeg-2026` fixture
//! under `fixtures/replays/`:
//!
//! 1. The replay runs end-to-end through the generic-harness path
//! (not the lending LiteSvmHarness) against a replay-scoped adapter
//! that mirrors `fixtures/adapters/liquid-staking-fork.toml` plus a
//! scoped `no_queue_formation` invariant.
//! 2. The result is deterministic across same-fixture runs.
//! 3. The canonical replay output hash + the `invariants_fired`
//! rollup stay pinned to the checked-in `expected-summary.json`.
//! 4. `no_slash_during_healthy_run` fires at tick 3 (the scheduled
//! `apply_slash`) and persists through the terminal tick.
//! 5. `no_queue_formation` fires at tick 4 (the withdrawal-run
//! materializes) and persists through the terminal tick.
//!
//! This is the credibility claim the spec asks for: a named depeg /
//! redemption-pressure proof where at least one machine-checkable
//! invariant fires at a named tick, with a stable rerun command and
//! artifact set. The proof is single-program on purpose — it does NOT
//! model cross-protocol Aave-style contagion. The Kelp-style /
//! rsETH-style framing is only about the failure *shape* (slash →
//! rate depeg → redemption run → queue formation).

#![cfg(feature = "litesvm-backend")]
#![cfg(not(doctest))]

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use riptide_engine::{
    adapter::load_adapter,
    primitive::{GenericBootstrapConfig, GenericHarness},
    replay::{load_replay_bundle, run_replay},
    types::SimulationResult,
};

fn monorepo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("engine crate has a parent directory")
        .to_path_buf()
}

fn fixture_dir() -> PathBuf {
    monorepo_root()
        .join("fixtures")
        .join("replays")
        .join("liquid-staking-kelp-depeg-2026")
}

fn skip_if_missing(path: &Path, label: &str) -> bool {
    if !path.exists() {
        // CI must hard-fail on a missing SBF artifact so the replay
        // gate cannot go green without actually exercising replay
        // dispatch. Local dev keeps the soft skip so a fresh clone
        // without `cargo build-sbf` does not red-line the whole suite.
        if std::env::var("CI").map(|v| !v.is_empty()).unwrap_or(false) {
            panic!(
                "CI={}: refusing to soft-skip on missing {label} at {} — \
                 build it with `cargo build-sbf` before running the test suite",
                std::env::var("CI").unwrap_or_default(),
                path.display()
            );
        }
        eprintln!("skipping: {label} missing at {}", path.display());
        true
    } else {
        false
    }
}

#[derive(Debug, Deserialize)]
struct ExpectedSummary {
    result_sha256: String,
    total_ticks: u32,
    event_count: usize,
    invariant_firings: BTreeMap<String, usize>,
    invariant_first_firing_tick: BTreeMap<String, u32>,
    summary: BTreeMap<String, Value>,
}

fn canonicalize(mut result: SimulationResult) -> SimulationResult {
    result.run_config.output_path = "__canonical__".to_string();
    result
}

fn canonical_hash(result: &SimulationResult) -> String {
    let bytes = serde_json::to_vec(result).expect("serialize canonical replay result");
    let digest = Sha256::digest(&bytes);
    format!("{digest:x}")
}

fn run_fixture() -> SimulationResult {
    let fixture = fixture_dir();
    let adapter = load_adapter(&fixture.join("adapter.toml"))
        .expect("load replay-scoped liquid-staking-fork adapter");
    let bundle = load_replay_bundle(&fixture, &adapter).expect("load replay bundle");

    let idl_path = PathBuf::from(
        adapter
            .idl_path
            .clone()
            .expect("replay adapter declares idl_path"),
    );
    let mut harness = GenericHarness::bootstrap(GenericBootstrapConfig {
        program_so: PathBuf::from(
            adapter
                .program_so
                .clone()
                .expect("replay adapter declares program_so"),
        ),
        idl_path,
        agent_count: bundle.actor_ids.len(),
        adapter: adapter.clone(),
    })
    .expect("bootstrap replay harness");

    canonicalize(
        run_replay(&mut harness, &adapter, &bundle, "__canonical__".into())
            .expect("run replay"),
    )
}

/// Walk the events and pick the first tick at which an
/// `invariant_violation:<name>` event fires. Returns `None` if the
/// invariant never fired during the run — the caller surfaces that
/// as a clean assertion failure so "it fires at the expected tick"
/// cannot silently become "it never fires at all".
fn first_firing_tick(result: &SimulationResult, invariant_name: &str) -> Option<u32> {
    let needle = format!("invariant_violation:{invariant_name}");
    result
        .events
        .iter()
        .find(|event| event.action == needle)
        .map(|event| event.tick)
}

#[test]
fn liquid_staking_kelp_depeg_2026_matches_expected_and_is_deterministic() {
    // Artifact gate runs up front: CI hard-fails on a missing SBF
    // artifact (`skip_if_missing` panics when `CI` is set), local dev
    // soft-skips by early-returning from the test body. This is the
    // pattern `replay_framework.rs` uses and is the only correct way
    // to honour the "local dev keeps the soft skip" comment — a panic
    // in a helper function would silently turn the soft-skip claim
    // into a hard-fail.
    let repo = monorepo_root();
    let required_artifacts: &[(PathBuf, &str)] = &[
        (
            repo.join("programs/liquid-staking-fork/target/deploy/liquid_staking_fork.so"),
            "liquid_staking_fork.so",
        ),
        (
            repo.join("programs/admin_mock_oracle/target/deploy/admin_mock_oracle.so"),
            "admin_mock_oracle.so",
        ),
        (
            repo.join("programs/admin_mock_oracle/target/deploy/admin_mock_oracle-keypair.json"),
            "admin_mock_oracle-keypair.json",
        ),
    ];
    for (path, label) in required_artifacts {
        if skip_if_missing(path, label) {
            return;
        }
    }

    let fixture = fixture_dir();
    let expected: ExpectedSummary = serde_json::from_str(
        &fs::read_to_string(fixture.join("expected-summary.json"))
            .expect("read expected-summary.json"),
    )
    .expect("parse expected summary");

    let first = run_fixture();
    let second = run_fixture();

    assert_eq!(
        first, second,
        "liquid-staking Kelp-depeg replay diverged across back-to-back runs",
    );

    let actual_hash = canonical_hash(&first);
    assert_eq!(
        actual_hash,
        expected.result_sha256,
        "liquid-staking Kelp-depeg replay hash drifted; update \
         fixtures/replays/liquid-staking-kelp-depeg-2026/expected-summary.json if \
         the new output is intentional",
    );

    assert_eq!(first.total_ticks, expected.total_ticks);
    assert_eq!(first.events.len(), expected.event_count);
    assert_eq!(
        first.run_config.scenario,
        "replay:liquid-staking-kelp-style-depeg-2026"
    );

    let invariant_rows = first
        .summary
        .get("invariants_fired")
        .and_then(|v| v.as_array())
        .expect("replay-scoped adapter declares invariants, so invariants_fired must be present");
    assert_eq!(
        invariant_rows.len(),
        expected.invariant_firings.len(),
        "invariants_fired row count drifted",
    );
    for row in invariant_rows {
        let name = row["name"].as_str().expect("invariant row `name`").to_string();
        let firings = row["firings"].as_u64().expect("invariant row `firings`") as usize;
        let expected_firings = expected
            .invariant_firings
            .get(&name)
            .copied()
            .unwrap_or_else(|| panic!("unexpected invariant `{name}` in replay output"));
        assert_eq!(
            firings, expected_firings,
            "invariant `{name}` firing count drifted",
        );
        assert!(
            expected_firings >= 1,
            "expected-summary baseline claims invariant `{name}` never fires — that breaks the credibility contract",
        );
        let expected_first = expected
            .invariant_first_firing_tick
            .get(&name)
            .copied()
            .unwrap_or_else(|| panic!("missing first-firing-tick baseline for `{name}`"));
        let actual_first = first_firing_tick(&first, &name).unwrap_or_else(|| {
            panic!(
                "invariant `{name}` reports {firings} firings in summary but no \
                 `invariant_violation:{name}` event in the stream"
            )
        });
        assert_eq!(
            actual_first, expected_first,
            "invariant `{name}` first-firing tick drifted",
        );
    }

    for (key, expected_value) in &expected.summary {
        assert_eq!(
            first.summary.get(key),
            Some(expected_value),
            "summary key `{key}` drifted",
        );
    }
}
