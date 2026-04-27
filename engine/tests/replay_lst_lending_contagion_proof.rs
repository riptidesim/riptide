//! Cross-protocol contagion proof gate — LST depeg → lending bad debt.
//!
//! This test pins the first multi-program evidence artifact: an upstream
//! liquid-staking slash at tick 3 drops `pool.exchange_rate_bps` from
//! 10000 to 6000, the declared `lst_exchange_rate_to_lending_oracle`
//! bridge maps that observation into a $60 downstream collateral oracle
//! price, and the lending whale-position cascade at tick 4 realizes
//! bad debt that would not have landed under the pre-shock oracle.
//!
//! Three things are locked:
//!
//! 1. The composed replay runs end-to-end through the multi-component
//!    coordinator against the shipping `liquid-staking` and
//!    `lending_pool` programs loaded into one shared LiteSVM.
//! 2. The canonical `SimulationResult` hash + summary subset stay
//!    byte-pinned to the checked-in `expected-summary.json` baseline.
//! 3. The downstream `lending:no_bad_debt` invariant fires exactly once
//!    at tick 4 — the terminal cascade — because the bridge has already
//!    mutated the lending oracle at tick 3. The upstream
//!    `liquid_staking:no_slash_during_healthy_run` invariant fires
//!    starting tick 3, showing the same trace tells the depeg half of
//!    the contagion story.

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
    replay::{load_replay_config, run_multi_replay, MultiComponentHarness, ReplayConfigShape},
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
        .join("lst-lending-contagion-proof")
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
    let bytes = serde_json::to_vec(result).expect("serialize canonical contagion result");
    let digest = Sha256::digest(&bytes);
    format!("{digest:x}")
}

fn run_fixture() -> SimulationResult {
    let fixture = fixture_dir();
    let shape = load_replay_config(&fixture.join("config.json"))
        .expect("load multi-component contagion config");
    let cfg = match shape {
        ReplayConfigShape::Multi(cfg) => cfg,
        ReplayConfigShape::Legacy(_) => {
            panic!("contagion config must parse on the multi-component branch")
        }
    };
    let mut harness = MultiComponentHarness::bootstrap(&cfg, &fixture)
        .expect("bootstrap multi-component harness against the shipping bundles");
    canonicalize(
        run_multi_replay(&mut harness, "__canonical__".into())
            .expect("run multi-component contagion replay"),
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

/// One-shot helper to regenerate `expected-summary.json` when a
/// deliberate fixture, program, or replay-coordinator change shifts the
/// canonical hash. Gated on `RIPTIDE_DUMP_EXPECTED=1` so it never runs
/// in CI. Invocation:
///   `RIPTIDE_DUMP_EXPECTED=1 cargo test --features litesvm-backend \
///     --test replay_lst_lending_contagion_proof \
///     dump_expected_summary -- --nocapture`
#[test]
fn dump_expected_summary() {
    if std::env::var("RIPTIDE_DUMP_EXPECTED").ok().as_deref() != Some("1") {
        return;
    }
    for (path, label) in required_artifacts() {
        if skip_if_missing(&path, label) {
            return;
        }
    }
    let result = run_fixture();
    let hash = canonical_hash(&result);
    let invariant_rows = result
        .summary
        .get("invariants_fired")
        .and_then(|v| v.as_array())
        .expect("contagion proof declares qualified invariants");
    let firings: BTreeMap<String, usize> = invariant_rows
        .iter()
        .map(|row| {
            let name = row["name"].as_str().unwrap().to_string();
            let n = row["firings"].as_u64().unwrap() as usize;
            (name, n)
        })
        .collect();
    let first_ticks: BTreeMap<String, u32> = firings
        .iter()
        .filter(|(_, n)| **n > 0)
        .map(|(name, _)| {
            let tick = first_firing_tick(&result, name)
                .unwrap_or_else(|| panic!("no firing for invariant `{name}`"));
            (name.clone(), tick)
        })
        .collect();
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
fn contagion_proof_matches_expected_summary_and_is_deterministic() {
    for (path, label) in required_artifacts() {
        if skip_if_missing(&path, label) {
            return;
        }
    }

    let expected: ExpectedSummary = serde_json::from_str(
        &fs::read_to_string(fixture_dir().join("expected-summary.json"))
            .expect("read expected-summary.json"),
    )
    .expect("parse expected summary");

    let first = run_fixture();
    let second = run_fixture();

    assert_eq!(
        first, second,
        "LST → lending contagion replay diverged across back-to-back runs"
    );

    let actual_hash = canonical_hash(&first);
    assert_eq!(
        actual_hash, expected.result_sha256,
        "LST → lending contagion replay hash drifted; \
         regenerate fixtures/replays/lst-lending-contagion-proof/expected-summary.json \
         with RIPTIDE_DUMP_EXPECTED=1 if the new output is intentional",
    );

    assert_eq!(first.total_ticks, expected.total_ticks);
    assert_eq!(first.events.len(), expected.event_count);

    assert_eq!(
        first.run_config.scenario, "replay:multi:lst-lending-contagion-proof-upstream",
        "contagion scenario tag must derive from the upstream component's metadata.name",
    );

    // ---- Every expected summary key round-trips byte-identically. ----
    for (key, expected_value) in &expected.summary {
        assert_eq!(
            first.summary.get(key),
            Some(expected_value),
            "summary key `{key}` drifted",
        );
    }

    // ---- Invariant firings match baseline exactly. ----
    let invariant_rows = first
        .summary
        .get("invariants_fired")
        .and_then(|v| v.as_array())
        .expect("contagion proof declares qualified invariants");
    for row in invariant_rows {
        let name = row["name"].as_str().expect("invariant name").to_string();
        let firings = row["firings"]
            .as_u64()
            .expect("invariant firings is numeric") as usize;
        assert_eq!(
            Some(&firings),
            expected.invariant_firings.get(&name),
            "invariant `{name}` firing count drifted",
        );
        if firings > 0 {
            let actual_tick = first_firing_tick(&first, &name)
                .unwrap_or_else(|| panic!("expected firing event for `{name}`"));
            assert_eq!(
                Some(&actual_tick),
                expected.invariant_first_firing_tick.get(&name),
                "invariant `{name}` first-firing tick drifted",
            );
        }
    }

    // ---- Contagion attribution: the downstream fires BECAUSE of the ----
    // ---- upstream, not because the two happened to line up. ----

    // Upstream depeg evidence: exchange rate must drop between pre-
    // and post-slash ticks.
    let pre_slash = first
        .timeseries
        .iter()
        .find(|s| s.get("tick").and_then(|v| v.as_u64()) == Some(2))
        .expect("pre-slash snapshot present");
    let post_slash = first
        .timeseries
        .iter()
        .find(|s| s.get("tick").and_then(|v| v.as_u64()) == Some(3))
        .expect("post-slash snapshot present");
    let pre_rate = pre_slash
        .get("liquid_staking.pool.exchange_rate_bps")
        .and_then(|v| v.as_f64())
        .expect("pre-slash LST rate present");
    let post_rate = post_slash
        .get("liquid_staking.pool.exchange_rate_bps")
        .and_then(|v| v.as_f64())
        .expect("post-slash LST rate present");
    assert!(
        (pre_rate - 10000.0).abs() < 1e-6,
        "pre-slash exchange_rate_bps should be the 10000-bps baseline; got {pre_rate}"
    );
    assert!(
        post_rate <= 6000.0 + 1e-6,
        "post-slash exchange_rate_bps should drop to at most 6000 bps; got {post_rate}"
    );

    // Bridge propagation evidence: the lending oracle drops from its
    // pre-shock $100 to bps-ratio(post_rate). The lending component
    // has NO oracle-trajectory.json of its own, so any change here is
    // the bridge.
    let pre_oracle = pre_slash
        .get("lending.oracle_price")
        .and_then(|v| v.as_f64())
        .expect("pre-slash lending oracle price present");
    let post_oracle = post_slash
        .get("lending.oracle_price")
        .and_then(|v| v.as_f64())
        .expect("post-slash lending oracle price present");
    let expected_pre = 100.0 * (pre_rate / 10000.0);
    let expected_post = 100.0 * (post_rate / 10000.0);
    assert!(
        (pre_oracle - expected_pre).abs() < 1e-6,
        "pre-slash bridge should hold lending oracle at {expected_pre}, got {pre_oracle}"
    );
    assert!(
        (post_oracle - expected_post).abs() < 1e-6,
        "post-slash bridge should drop lending oracle to {expected_post}, got {post_oracle}"
    );
    assert!(
        pre_oracle - post_oracle > 10.0,
        "bridge should materially drop the lending oracle across the slash; \
         pre={pre_oracle}, post={post_oracle}"
    );

    // Downstream signal evidence: bad debt lands at the terminal
    // cascade tick, not before.
    let terminal = first
        .timeseries
        .iter()
        .find(|s| s.get("tick").and_then(|v| v.as_u64()) == Some(4))
        .expect("terminal tick present");
    let terminal_bad_debt = terminal
        .get("lending.pool.bad_debt")
        .and_then(|v| v.as_f64())
        .expect("terminal bad_debt present");
    assert!(
        terminal_bad_debt > 0.0,
        "terminal liquidation cascade should realize bad debt on the bridged oracle; \
         got bad_debt={terminal_bad_debt}"
    );
    assert_eq!(
        post_slash
            .get("lending.pool.bad_debt")
            .and_then(|v| v.as_f64()),
        Some(0.0),
        "bad debt must NOT exist at tick 3 — the terminal cascade is what realizes it at tick 4"
    );

    // The downstream invariant that fires is the contagion proof.
    let no_bad_debt_firing_tick =
        first_firing_tick(&first, "lending:no_bad_debt").expect("lending:no_bad_debt must fire");
    assert_eq!(
        no_bad_debt_firing_tick, 4,
        "contagion proof claim: `lending:no_bad_debt` fires at the terminal cascade tick \
         (tick 4), which runs against the bridge-written oracle price"
    );

    // Bridge event trace: at least one `bridge:<name>` event per tick
    // (the coordinator evaluates bridges sourced from the upstream
    // component every tick, whether or not the observation moved).
    let bridge_events: Vec<_> = first
        .events
        .iter()
        .filter(|e| e.action == "bridge:lst_exchange_rate_to_lending_oracle")
        .collect();
    assert!(
        bridge_events.len() >= 3,
        "expected a bridge firing for every upstream tick (>=3), got {}",
        bridge_events.len()
    );
    for event in &bridge_events {
        assert_eq!(
            event
                .params
                .get("source_component")
                .and_then(|v| v.as_str()),
            Some("liquid_staking")
        );
        assert_eq!(
            event
                .params
                .get("target_component")
                .and_then(|v| v.as_str()),
            Some("lending")
        );
    }
}
