//! Liquid-staking slash-with-open-queue replay gate.
//!
//! Sibling to `replay_liquid_staking_depeg_redemption_run`. Where that
//! fixture slashes before any redemption demand (the queue never opens
//! until after the slash), this fixture reorders the trajectory so the
//! withdrawal run at tick 3 lands four stakers on the queue *before*
//! `apply_slash` fires at tick 4. That ordering is what actually
//! exercises the `recompute_exchange_rate` formula — with a non-zero
//! `pending_unstake_assets` at slash time — and is the regime that
//! inverted the depeg signal under the pre-fix implementation.
//!
//! Locks four things:
//!
//! 1. The replay runs end-to-end through the generic-harness path.
//! 2. The result is deterministic across same-fixture runs.
//! 3. The canonical replay output hash + `invariants_fired` rollup
//!    stay pinned to the checked-in `expected-summary.json`.
//! 4. All three declared invariants fire at their named ticks:
//!    - `no_queue_formation` first fires at tick 3 (withdrawal run),
//!    - `no_slash_during_healthy_run` first fires at tick 4 (slash),
//!    - `no_catastrophic_depeg` first fires at tick 4 — the smoking
//!      gun for the fix. Under the pre-fix formula the post-slash
//!      rate would be ~26_000 bps (peg spuriously strengthens) and
//!      the `>= 5000 bps` invariant would never fire. Firing at tick
//!      4 with the rate at 2_000 bps is the machine-checkable
//!      evidence that the formula subtracts pending correctly.

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
        .join("liquid-staking-slash-with-open-queue")
}

fn skip_if_missing(path: &Path, label: &str) -> bool {
    if !path.exists() {
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
        .expect("load replay-scoped liquid-staking adapter");
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
        run_replay(&mut harness, &adapter, &bundle, "__canonical__".into()).expect("run replay"),
    )
}

fn first_firing_tick(result: &SimulationResult, invariant_name: &str) -> Option<u32> {
    let needle = format!("invariant_violation:{invariant_name}");
    result
        .events
        .iter()
        .find(|event| event.action == needle)
        .map(|event| event.tick)
}

/// One-shot helper to regenerate `expected-summary.json` after a
/// deliberate fixture or program change. Gated on
/// `RIPTIDE_DUMP_EXPECTED=1` so it never runs in CI and costs nothing
/// when nobody asks. Run:
///   `RIPTIDE_DUMP_EXPECTED=1 cargo test --features litesvm-backend \
///     --test replay_liquid_staking_slash_with_open_queue \
///     dump_expected_summary -- --nocapture`
#[test]
fn dump_expected_summary() {
    if std::env::var("RIPTIDE_DUMP_EXPECTED").ok().as_deref() != Some("1") {
        return;
    }
    let result = run_fixture();
    let hash = canonical_hash(&result);
    let invariant_rows = result
        .summary
        .get("invariants_fired")
        .and_then(|v| v.as_array())
        .expect("replay adapter declares invariants");
    let firings: BTreeMap<String, usize> = invariant_rows
        .iter()
        .map(|row| {
            let name = row["name"].as_str().unwrap().to_string();
            let n = row["firings"].as_u64().unwrap() as usize;
            (name, n)
        })
        .collect();
    let first_ticks: BTreeMap<String, u32> = firings
        .keys()
        .map(|name| {
            let tick = first_firing_tick(&result, name)
                .unwrap_or_else(|| panic!("no firing for invariant `{name}`"));
            (name.clone(), tick)
        })
        .collect();
    // Drop the `invariants_fired` rollup from the summary dump so the
    // expected-summary check doesn't double-assert on it (firings and
    // first-firing ticks are already locked above by
    // `invariant_firings` / `invariant_first_firing_tick`).
    let summary_subset: BTreeMap<String, Value> = result
        .summary
        .iter()
        .filter(|(k, _)| k.as_str() != "invariants_fired")
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    let dump = serde_json::json!({
        "result_sha256": hash,
        "total_ticks": result.total_ticks,
        "event_count": result.events.len(),
        "invariant_firings": firings,
        "invariant_first_firing_tick": first_ticks,
        "summary": summary_subset,
    });
    println!(
        "===== BEGIN expected-summary.json =====\n{}\n===== END expected-summary.json =====",
        serde_json::to_string_pretty(&dump).unwrap()
    );
}

#[test]
fn liquid_staking_slash_with_open_queue_matches_expected_and_is_deterministic() {
    let repo = monorepo_root();
    let required_artifacts: &[(PathBuf, &str)] = &[
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
        "liquid-staking slash-with-open-queue replay diverged across back-to-back runs",
    );

    let actual_hash = canonical_hash(&first);
    assert_eq!(
        actual_hash, expected.result_sha256,
        "liquid-staking slash-with-open-queue replay hash drifted; update \
         fixtures/replays/liquid-staking-slash-with-open-queue/expected-summary.json if \
         the new output is intentional",
    );

    assert_eq!(first.total_ticks, expected.total_ticks);
    assert_eq!(first.events.len(), expected.event_count);
    assert_eq!(
        first.run_config.scenario,
        "replay:liquid-staking-slash-with-open-queue"
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
        let name = row["name"]
            .as_str()
            .expect("invariant row `name`")
            .to_string();
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
