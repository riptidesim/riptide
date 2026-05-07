//! KelpDAO-shape unbacked-LST replay gate.
//!
//! Historical inspiration: the June 2024 KelpDAO / rsETH bridge-trust
//! failure. KelpDAO is on Ethereum; this pack reproduces the
//! ECONOMIC GEOMETRY on Riptide's shipped Solana liquid-staking fork
//! — it is NOT a byte-level reconstruction of EigenLayer / rsETH /
//! Kelp's source. The toy program ships an admin `AdminMintLst`
//! instruction that mirrors the unauthorized-mint accounting flaw:
//! LST is created without depositing underlying assets and without
//! recomputing the exchange rate, so `lst_supply * exchange_rate_bps`
//! exceeds `total_assets * 10000`.
//!
//! This test locks four things:
//!
//! 1. The replay runs end-to-end through the generic-harness path on
//!    the replay-scoped adapter
//!    `fixtures/replays/kelpdao-unbacked-rseth/adapter.toml` — a copy
//!    of the shipping `liquid-staking.toml` trimmed to a single
//!    `full_backing` semantic invariant at severity `critical`. The
//!    shipping adapter stays clean so the depeg-redemption-run replay
//!    hash and the smoke gate's hero hash do not drift.
//! 2. The result is deterministic across same-fixture runs.
//! 3. The canonical replay output hash + the `expression_invariants`
//!    rollup stay pinned to the checked-in `expected-summary.json`.
//! 4. `full_backing` fires at tick 1 (the scheduled
//!    `admin_mint_lst(5000)`) and persists through the terminal tick.
//!    This is the credibility claim: the engine's machine-checkable
//!    semantic-invariant framework fires on the unbacked-LST geometry
//!    the slide names.

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
        .join("kelpdao-unbacked-rseth")
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
    expression_invariant_firings: BTreeMap<String, usize>,
    expression_invariant_first_firing_tick: BTreeMap<String, u32>,
    summary: BTreeMap<String, Value>,
}

fn canonicalize(mut result: SimulationResult) -> SimulationResult {
    result.run_config.output_path = "__canonical__".to_string();
    result
}

/// Mirrors `riptide_engine::pack::canonical_hash` — the same hash the
/// pack tool writes into `manifest.json`. The replay produces a
/// `expression_invariants` summary entry and a `derived_observations`
/// per-tick block; both are stripped from the canonical-hash input so
/// the manifest hash an outside auditor sees on rerun matches what
/// this gate pins.
fn canonical_hash(result: &SimulationResult) -> String {
    let mut canonical = result.clone();
    canonical.run_config.output_path = "__canonical__".to_string();
    canonical.semantics = None;
    canonical.summary.remove("expression_invariants");
    for tick in &mut canonical.timeseries {
        tick.remove("derived_observations");
    }
    let bytes = serde_json::to_vec(&canonical).expect("serialize canonical replay result");
    let digest = Sha256::digest(&bytes);
    format!("{digest:x}")
}

fn run_fixture() -> SimulationResult {
    let fixture = fixture_dir();
    let adapter = load_adapter(&fixture.join("adapter.toml"))
        .expect("load replay-scoped KelpDAO-shape liquid-staking adapter");
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

fn first_expression_firing_tick(result: &SimulationResult, invariant_name: &str) -> Option<u32> {
    let rows = result
        .summary
        .get("expression_invariants")
        .and_then(|v| v.as_array())?;
    rows.iter().find_map(|row| {
        if row.get("name").and_then(|v| v.as_str()) == Some(invariant_name) {
            row.get("first_tick").and_then(|v| v.as_u64()).map(|tick| tick as u32)
        } else {
            None
        }
    })
}

/// One-shot helper to regenerate `expected-summary.json` after a
/// deliberate fixture or program change. Gated on
/// `RIPTIDE_DUMP_EXPECTED=1` so it never runs in CI and costs nothing
/// when nobody asks. Run:
///   `RIPTIDE_DUMP_EXPECTED=1 cargo test --features litesvm-backend \
///     --test replay_kelpdao_unbacked_rseth \
///     dump_expected_summary -- --nocapture`
#[test]
fn dump_expected_summary() {
    if std::env::var("RIPTIDE_DUMP_EXPECTED").ok().as_deref() != Some("1") {
        return;
    }
    let result = run_fixture();
    let hash = canonical_hash(&result);
    let expression_rows = result
        .summary
        .get("expression_invariants")
        .and_then(|v| v.as_array())
        .expect("replay adapter declares semantic invariants");
    let expression_firings: BTreeMap<String, usize> = expression_rows
        .iter()
        .map(|row| {
            let name = row["name"].as_str().unwrap().to_string();
            let n = row["firings"].as_u64().unwrap() as usize;
            (name, n)
        })
        .collect();
    let expression_first_ticks: BTreeMap<String, u32> = expression_rows
        .iter()
        .filter_map(|row| {
            let name = row["name"].as_str()?.to_string();
            let tick = row.get("first_tick").and_then(|v| v.as_u64())? as u32;
            Some((name, tick))
        })
        .collect();
    let summary_subset: BTreeMap<String, Value> = result
        .summary
        .iter()
        .filter(|(k, _)| {
            !matches!(
                k.as_str(),
                "expression_invariants" | "invariants_fired"
            )
        })
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    let dump = serde_json::json!({
        "result_sha256": hash,
        "total_ticks": result.total_ticks,
        "event_count": result.events.len(),
        "expression_invariant_firings": expression_firings,
        "expression_invariant_first_firing_tick": expression_first_ticks,
        "summary": summary_subset,
    });
    println!(
        "===== BEGIN expected-summary.json =====\n{}\n===== END expected-summary.json =====",
        serde_json::to_string_pretty(&dump).unwrap()
    );
}

#[test]
fn kelpdao_unbacked_rseth_matches_expected_summary_and_is_deterministic() {
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
        "KelpDAO unbacked-rsETH replay diverged across back-to-back runs",
    );

    let actual_hash = canonical_hash(&first);
    assert_eq!(
        actual_hash, expected.result_sha256,
        "KelpDAO unbacked-rsETH replay hash drifted; update fixtures/replays/kelpdao-unbacked-rseth/expected-summary.json if the new output is intentional",
    );

    assert_eq!(first.total_ticks, expected.total_ticks);
    assert_eq!(first.events.len(), expected.event_count);
    assert_eq!(first.run_config.scenario, "replay:kelpdao-unbacked-rseth");

    let expression_rows = first
        .summary
        .get("expression_invariants")
        .and_then(|v| v.as_array())
        .expect("replay-scoped adapter declares semantic invariants, so expression_invariants must be present");

    for row in expression_rows {
        let name = row["name"].as_str().expect("invariant row name").to_string();
        let firings = row["firings"].as_u64().expect("invariant row firings") as usize;
        let expected_firings = expected
            .expression_invariant_firings
            .get(&name)
            .copied()
            .unwrap_or_else(|| panic!("unexpected semantic invariant `{name}` in replay output"));
        assert_eq!(
            firings, expected_firings,
            "semantic invariant `{name}` firing count drifted",
        );
        assert!(
            expected_firings >= 1,
            "expected-summary baseline claims semantic invariant `{name}` never fires — that breaks the credibility contract",
        );
        let expected_first = expected
            .expression_invariant_first_firing_tick
            .get(&name)
            .copied()
            .unwrap_or_else(|| panic!("missing first-firing-tick baseline for `{name}`"));
        let actual_first = first_expression_firing_tick(&first, &name).unwrap_or_else(|| {
            panic!("semantic invariant `{name}` reports {firings} firings but no first_tick")
        });
        assert_eq!(
            actual_first, expected_first,
            "semantic invariant `{name}` first-firing tick drifted",
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
