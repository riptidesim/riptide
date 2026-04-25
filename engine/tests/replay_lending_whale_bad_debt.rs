//! Lending whale-concentrated-borrow bad-debt replay gate.
//!
//! Historical inspiration: the June 2022 Solend whale-risk incident
//! (SLND1/SLND2). This test pins the *failure shape* on the shipped
//! Solana lending fork — whale borrow concentration + oracle drawdown
//! → realized bad debt — not a byte-level on-chain reconstruction.
//!
//! This test locks four things:
//!
//! 1. The replay runs end-to-end on the replay-scoped adapter
//! `fixtures/replays/lending-whale-bad-debt/adapter.toml` — a copy of
//! the shipped `lending.toml` with a `no_bad_debt` invariant added.
//! The shipped adapter stays clean so the hero-grid hash
//! `89ca84209f3423c317e6be96f14261a9ebed7a9668398a08087a25631b782a11`
//! (which also produces bad debt at `w25-s40`) stays byte-stable.
//! 2. The result is deterministic under a fixed trajectory.
//! 3. The canonical replay output hash + summary stay pinned to the
//! checked-in `expected-summary.json` baseline.
//! 4. The declared `no_bad_debt` invariant fires **at tick 4** — the
//! terminal cascade — and only there. This is the credibility
//! claim (`tasks.md` "Done when" clause 3, spec R2.3): the
//! replay does not just *observe* bad debt accrue, the engine's
//! machine-checkable invariant framework fires on it.

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
    harness::lending::LendingPoolConfig,
    replay::{load_replay_bundle, run_replay},
    scenario::OracleUpdate,
    sim::litesvm::{LiteSvmBootstrapConfig, LiteSvmHarness},
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
        .join("lending-whale-bad-debt")
}

fn skip_if_missing(path: &Path, label: &str) -> bool {
    if !path.exists() {
        // Same Finding #3 guard as `replay_framework`:
        // CI=true turns missing-artifact into a hard fail so replay
        // gates cannot go green without exercising replay dispatch.
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
    event_count: usize,
    terminal_bad_debt_tick: u32,
    bad_debt_invariant_firings: usize,
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
    let repo = monorepo_root();
    let fixture = fixture_dir();
    let program_so = repo.join("programs/lending_pool/target/deploy/lending_pool.so");
    if skip_if_missing(&program_so, "lending_pool.so") {
        panic!("required artifact missing");
    }

    let adapter = load_adapter(&fixture.join("adapter.toml"))
        .expect("load replay-scoped lending adapter");
    let bundle = load_replay_bundle(&fixture, &adapter).expect("load replay bundle");

    let bootstrap_price = OracleUpdate {
        price: bundle.starting_price,
        exponent: bundle.starting_exponent,
    };
    let mut harness = LiteSvmHarness::bootstrap(LiteSvmBootstrapConfig {
        program_so,
        agent_count: bundle.actor_ids.len(),
        starting_price: bootstrap_price.as_u64(),
        price_exponent: bootstrap_price.exponent,
        pool_config: LendingPoolConfig {
            ltv_bps: 7_000,
            liquidation_threshold_bps: 8_000,
            liquidation_bonus_bps: 500,
            interest_bps: 250,
            deposit_limit: u64::MAX / 4,
            borrow_limit: u64::MAX / 4,
        },
        seed_deposit: 0,
        adapter: Some(adapter.clone()),
    })
    .expect("bootstrap replay harness");

    canonicalize(
        run_replay(&mut harness, &adapter, &bundle, "__canonical__".into())
            .expect("run replay"),
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
///     --test replay_lending_whale_bad_debt \
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
fn lending_whale_bad_debt_matches_expected_summary_and_is_deterministic() {
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
        "lending whale-bad-debt replay diverged across back-to-back runs",
    );

    let actual_hash = canonical_hash(&first);
    assert_eq!(
        actual_hash,
        expected.result_sha256,
        "lending whale-bad-debt replay hash drifted; update fixtures/replays/lending-whale-bad-debt/expected-summary.json if the new output is intentional",
    );

    assert_eq!(first.total_ticks, 4);
    assert_eq!(first.events.len(), expected.event_count);
    // Events split: N scheduled replay events (all successful tick-4
    // liquidations) + 1 per-invariant-firing event with action
    // `invariant_violation:<name>` emitted by the tick-4 evaluator.
    let liquidation_events = first
        .events
        .iter()
        .filter(|event| event.action == "liquidate")
        .count();
    let invariant_events = first
        .events
        .iter()
        .filter(|event| event.action.starts_with("invariant_violation:"))
        .count();
    assert_eq!(liquidation_events + invariant_events, first.events.len());
    assert!(
        first
            .events
            .iter()
            .filter(|event| event.action == "liquidate")
            .all(|event| event.tick == 4 && event.outcome == riptide_engine::types::SimOutcome::Success),
        "every scheduled replay liquidation should succeed at tick 4",
    );
    assert_eq!(
        first.run_config.scenario,
        "replay:lending-whale-bad-debt"
    );
    let invariant_rows = first
        .summary
        .get("invariants_fired")
        .and_then(|v| v.as_array())
        .expect("replay-scoped adapter declares invariants, so invariants_fired must be present");
    assert_eq!(
        invariant_rows.len(),
        1,
        "replay adapter declares exactly one invariant (no_bad_debt)"
    );
    let no_bad_debt = &invariant_rows[0];
    assert_eq!(no_bad_debt["name"], "no_bad_debt");
    assert_eq!(no_bad_debt["field"], "bad_debt");
    assert_eq!(no_bad_debt["op"], "==");
    assert_eq!(
        no_bad_debt["firings"].as_u64().expect("firings is a number") as usize,
        expected.bad_debt_invariant_firings,
        "no_bad_debt invariant firing count drifted",
    );
    assert!(
        expected.bad_debt_invariant_firings >= 1,
        "expected-summary baseline claims the invariant does not fire — that breaks the credibility contract",
    );

    for (key, expected_value) in &expected.summary {
        assert_eq!(
            first.summary.get(key),
            Some(expected_value),
            "summary key `{key}` drifted",
        );
    }

    let terminal_bad_debt_tick = first
        .timeseries
        .iter()
        .find_map(|snapshot| {
            let bad_debt = snapshot.get("cumulative_bad_debt")?.as_f64()?;
            if bad_debt > 0.0 {
                snapshot.get("tick")?.as_u64().map(|tick| tick as u32)
            } else {
                None
            }
        })
        .expect("replay should realize bad debt at a terminal tick");
    assert_eq!(terminal_bad_debt_tick, expected.terminal_bad_debt_tick);

    // The no_bad_debt invariant reads `bad_debt` (aliased to
    // `cumulative_bad_debt`). Its firing tick therefore equals the
    // first tick at which cumulative_bad_debt > 0, which is the
    // terminal-liquidation tick. Assert both match tick 4.
    let first_invariant_event_tick = first
        .events
        .iter()
        .find_map(|event| {
            if event.action == "invariant_violation:no_bad_debt" {
                Some(event.tick)
            } else {
                None
            }
        })
        .expect("expected at least one invariant_violation:no_bad_debt event");
    assert_eq!(
        first_invariant_event_tick, expected.terminal_bad_debt_tick,
        "no_bad_debt invariant fired at a different tick than the cascade",
    );
}
