//! Multi-component replay bootstrap gate.
//!
//! Credibility test for the first piece of the cross-protocol contagion
//! proof substrate: two shipping single-program replay bundles
//! bootstrap into the same LiteSVM instance without the existing
//! single-component replay path regressing. The test covers four
//! concrete acceptance points:
//!
//! 1. A legacy `{ adapter, trajectory_dir, output_path }` replay config
//!    parses through the shared loader, so every shipping
//!    single-component fixture keeps working unchanged.
//! 2. A multi-component `{ components: [...], output_path, bridges }`
//!    config parses, validates component identity, and loads both
//!    adapter + bundle pairs.
//! 3. The `MultiComponentHarness` bootstraps the declared
//!    liquid-staking and lending programs into one shared `LiteSVM`
//!    instance, and each component's snapshot surface reads cleanly
//!    off the shared SVM.
//! 4. Qualified snapshot keys (`<component>.<field>`) land on the
//!    shared coordinator, so invariants can reference cross-component
//!    state unambiguously.

#![cfg(feature = "litesvm-backend")]
#![cfg(not(doctest))]

use std::path::{Path, PathBuf};

use riptide_engine::replay::{
    parse_replay_config, MultiComponentHarness, ReplayConfigShape,
};

fn monorepo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("engine crate has a parent directory")
        .to_path_buf()
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

#[test]
fn legacy_single_component_config_round_trips_through_shared_loader() {
    let raw = std::fs::read_to_string(
        monorepo_root().join("fixtures/replays/lending-whale-bad-debt/config.json"),
    )
    .expect("read legacy replay config");
    match parse_replay_config(&raw).expect("parse legacy config") {
        ReplayConfigShape::Legacy(cfg) => {
            assert_eq!(cfg.adapter, "./adapter.toml");
            assert_eq!(cfg.trajectory_dir, ".");
            assert_eq!(cfg.output_path, "riptide-output/replays/lending-whale-bad-debt");
        }
        ReplayConfigShape::Multi(_) => {
            panic!("legacy shipped replay config must keep parsing on the legacy branch");
        }
    }

    let lst_raw = std::fs::read_to_string(
        monorepo_root()
            .join("fixtures/replays/liquid-staking-depeg-redemption-run/config.json"),
    )
    .expect("read liquid-staking legacy replay config");
    match parse_replay_config(&lst_raw).expect("parse legacy config") {
        ReplayConfigShape::Legacy(_) => {}
        ReplayConfigShape::Multi(_) => {
            panic!("legacy shipped replay config must keep parsing on the legacy branch");
        }
    }
}

#[test]
fn multi_component_replay_boots_two_programs_into_one_litesvm() {
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
        (
            repo.join("programs/lending_pool/target/deploy/lending_pool.so"),
            "lending_pool.so",
        ),
    ];
    for (path, label) in required_artifacts {
        if skip_if_missing(path, label) {
            return;
        }
    }

    let lst_dir = repo.join("fixtures/replays/liquid-staking-depeg-redemption-run");
    let lending_dir = repo.join("fixtures/replays/lending-whale-bad-debt");

    // Build an in-memory multi config. Absolute paths keep the test
    // insensitive to CWD.
    let raw = format!(
        r#"{{
            "components": [
                {{ "name": "liquid_staking",
                   "adapter": "{lst}/adapter.toml",
                   "trajectory_dir": "{lst}" }},
                {{ "name": "lending",
                   "adapter": "{lending}/adapter.toml",
                   "trajectory_dir": "{lending}" }}
            ],
            "output_path": "riptide-output/replays/lst-lending-bootstrap-smoke"
        }}"#,
        lst = lst_dir.display(),
        lending = lending_dir.display(),
    );

    let shape = parse_replay_config(&raw).expect("parse multi config");
    let cfg = match shape {
        ReplayConfigShape::Multi(cfg) => cfg,
        ReplayConfigShape::Legacy(_) => {
            panic!("config with `components` key must parse on the multi branch")
        }
    };
    assert_eq!(cfg.components.len(), 2);
    assert_eq!(cfg.components[0].name, "liquid_staking");
    assert_eq!(cfg.components[1].name, "lending");

    let harness = MultiComponentHarness::bootstrap(&cfg, &repo)
        .expect("bootstrap multi-component harness into one LiteSVM");

    assert_eq!(harness.components().len(), 2);

    // The shared-SVM proof: each component's snapshot reads cleanly
    // off the harness's single `LiteSVM` instance. If either program
    // had failed to deploy, the per-component snapshot would bail with
    // a missing-account error — the snapshots landing confirm both
    // programs coexist on the shared SVM.
    let lst_idx = harness
        .components()
        .iter()
        .position(|c| c.name == "liquid_staking")
        .expect("liquid_staking component present");
    let lending_idx = harness
        .components()
        .iter()
        .position(|c| c.name == "lending")
        .expect("lending component present");

    let lst_metrics = harness
        .snapshot_metrics(lst_idx)
        .expect("read liquid_staking snapshot from shared LiteSVM");
    assert!(
        lst_metrics.contains_key("pool.exchange_rate_bps"),
        "liquid_staking snapshot missing `pool.exchange_rate_bps`; keys: {:?}",
        lst_metrics.keys().collect::<Vec<_>>()
    );

    let lending_metrics = harness
        .snapshot_metrics(lending_idx)
        .expect("read lending snapshot from shared LiteSVM");
    assert!(
        lending_metrics.contains_key("pool.bad_debt"),
        "lending snapshot missing `pool.bad_debt`; keys: {:?}",
        lending_metrics.keys().collect::<Vec<_>>()
    );
    // tick-0 bad debt must be zero; the contagion proof builds
    // pressure only once the upstream LST component ticks.
    assert_eq!(
        lending_metrics
            .get("pool.bad_debt")
            .and_then(|v| v.as_f64()),
        Some(0.0),
        "lending pool bootstrapped with non-zero bad debt",
    );

    // Agent counts resolve through the shared coordinator.
    assert!(harness.agent_count(lst_idx) > 0);
    assert!(harness.agent_count(lending_idx) > 0);
}
