//! Historical replay framework ( · gate).
//!
//! End-to-end coverage for the replay runner against the shipped
//! `resource-grinder` generic program. Covered:
//!
//! 1. `load_replay_bundle` accepts the fixture-directory contract:
//! `trajectory.json` required, `oracle-trajectory.json` optional,
//! `initial-state.json` optional.
//! 2. `run_replay` dispatches the declared instruction list in tick
//! order, bypassing persona compilation entirely.
//! 3. Tick snapshots + invariant rollups reuse the shared simulation
//! helpers, so the output stays schema-compatible with ordinary
//! simulation results.
//! 4. Determinism: same replay bundle + same adapter + same program
//! bytes => byte-identical `SimulationResult`.

#![cfg(feature = "litesvm-backend")]
#![cfg(not(doctest))]

use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

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

fn skip_if_missing(path: &Path, label: &str) -> bool {
    if !path.exists() {
        // Under CI (env CI=true or any non-empty value), a missing
        // required artifact is a hard fail — a soft-skip on CI turns
        // the replay-framework gate green without actually
        // exercising replay dispatch, which was flagged in review as
        // Finding #3. Local dev keeps the skip so
        // a fresh clone without `cargo build-sbf` artifacts does not
        // red-line the whole test suite.
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

fn canonical_bytes(result: &SimulationResult) -> Vec<u8> {
    serde_json::to_vec(result).expect("serialize replay result")
}

fn make_temp_dir(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("riptide-{label}-{nonce}"));
    fs::create_dir_all(&dir).expect("create temp replay dir");
    dir
}

#[test]
fn replay_framework_runs_deterministically_and_matches_simulation_schema() {
    let repo = monorepo_root();
    let program_so = repo.join("programs/resource_grinder/target/deploy/resource_grinder.so");
    if skip_if_missing(&program_so, "resource_grinder.so") {
        return;
    }

    let idl_path = repo.join("fixtures/idls/resource-grinder.json");
    let replay_dir = make_temp_dir("t20-replay");
    let adapter_path = replay_dir.join("resource-grinder-replay.toml");

    let adapter_toml = format!(
        r#"
protocol = "generic"
program_so = "{}"
idl_path = "{}"

[accounts.player]
kind = "agent"
space = 48

[accounts.marketplace]
kind = "shared"
space = 512

[instructions]
mine = {{ action = "mine", amount = "amount" }}
craft = {{ action = "craft", amount = "amount" }}
list_for_sale = {{ action = "list_for_sale", amount = "amount" }}

[state_mapping]
"player.gold" = "player.gold"
"player.wood" = "player.wood"
"marketplace.listings" = "marketplace.listings"

[actions.mine]
label = "Mine"
takes = ["amount"]

[actions.craft]
label = "Craft"
takes = ["amount"]

[actions.list_for_sale]
label = "List for sale"
takes = ["amount"]

[observations]
"player.gold" = "uint"
"player.wood" = "uint"
"marketplace.listings" = "map"

[[invariants]]
name = "gold_never_negative"
field = "player.gold"
op = ">="
value = 0

[personas.replay]
label = "Replay"
action_rate_multiplier = 0.0
action_weights = {{ mine = 0.0, craft = 0.0, list_for_sale = 0.0 }}
triggers = []
"#,
        program_so.display(),
        idl_path.display(),
    );

    fs::write(&adapter_path, adapter_toml).expect("write replay adapter");
    fs::write(
        replay_dir.join("initial-state.json"),
        serde_json::to_string_pretty(&serde_json::json!({
            "instructions": [
                { "name": "mine", "agent": "alice", "args": { "amount": 3 } }
            ]
        }))
        .unwrap()
            + "\n",
    )
    .expect("write initial-state.json");
    fs::write(
        replay_dir.join("trajectory.json"),
        serde_json::to_string_pretty(&serde_json::json!({
            "metadata": {
                "name": "resource-grinder-replay",
                "description": "Synthetic replay fixture",
                "source": "engine/tests/replay_framework.rs"
            },
            "ticks": [
                { "tick": 0, "instructions": [{ "name": "craft", "agent": "alice", "args": { "amount": 1 } }] },
                { "tick": 1, "instructions": [{ "name": "list_for_sale", "agent": "alice", "args": { "amount": 1 } }] },
                { "tick": 2, "instructions": [{ "name": "mine", "agent": "alice", "args": { "amount": 2 } }] },
                { "tick": 3, "instructions": [{ "name": "craft", "agent": "alice", "args": { "amount": 2 } }] },
                { "tick": 4, "instructions": [{ "name": "list_for_sale", "agent": "alice", "args": { "amount": 3 } }] }
            ]
        }))
        .unwrap()
        + "\n",
    )
    .expect("write trajectory.json");
    fs::write(
        replay_dir.join("oracle-trajectory.json"),
        serde_json::to_string_pretty(&serde_json::json!({
            "ticks": [
                { "tick": 0, "price": 100.0 },
                { "tick": 3, "price": 95.0 }
            ]
        }))
        .unwrap()
            + "\n",
    )
    .expect("write oracle-trajectory.json");

    let adapter = load_adapter(&adapter_path).expect("load replay adapter");
    let bundle = load_replay_bundle(&replay_dir, &adapter).expect("load replay bundle");
    assert_eq!(bundle.actor_ids, vec!["alice"]);
    assert_eq!(bundle.total_ticks, 4);

    let run_once = || {
        let mut harness = GenericHarness::bootstrap(GenericBootstrapConfig {
            program_so: program_so.clone(),
            idl_path: idl_path.clone(),
            agent_count: bundle.actor_ids.len(),
            adapter: adapter.clone(),
        })
        .expect("bootstrap replay harness");
        run_replay(&mut harness, &adapter, &bundle, "unused".into()).expect("run replay")
    };

    let first = run_once();
    let second = run_once();

    assert_eq!(
        canonical_bytes(&first),
        canonical_bytes(&second),
        "replay output diverged across back-to-back runs"
    );
    assert_eq!(first.total_ticks, 4);
    assert_eq!(first.timeseries.len(), 5, "ticks 0..=4 produce 5 snapshots");
    assert_eq!(first.run_config.scenario, "replay:resource-grinder-replay");
    assert!(
        first.run_config.personas.is_empty(),
        "replay should bypass personas"
    );
    assert_eq!(
        first.events.len(),
        5,
        "initial-state bootstrap should not emit replay events"
    );
    assert_eq!(first.events.first().unwrap().tick, 0);
    assert_eq!(first.events.first().unwrap().action, "craft");
    assert_eq!(first.agents.len(), 1);
    assert_eq!(first.agents[0].persona_id, "alice");
    assert_eq!(first.summary["agents_active"], 1);
    assert_eq!(first.summary["agents_liquidated"], 0);
    assert_eq!(first.summary["agents_depleted"], 0);
    let invariant_rows = first.summary["invariants_fired"]
        .as_array()
        .expect("invariants_fired array present");
    assert_eq!(invariant_rows.len(), 1);
    assert_eq!(invariant_rows[0]["name"], "gold_never_negative");
    assert_eq!(invariant_rows[0]["firings"], 0);
    assert_eq!(
        first.timeseries[0]["player.gold"].as_f64(),
        Some(1.0),
        "tick-0 snapshot should reflect initial-state bootstrap + tick-0 craft"
    );
    assert_eq!(
        first.timeseries[0]["player.wood"].as_f64(),
        Some(2.0),
        "tick-0 snapshot should reflect the remaining wood after craft"
    );
    assert_eq!(
        first.timeseries[1]["marketplace.listings"].as_f64(),
        Some(1.0),
        "listing count should be visible after the tick-1 list_for_sale action"
    );

    fs::remove_dir_all(&replay_dir).ok();
}
