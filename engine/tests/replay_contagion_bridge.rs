//! Contagion bridge propagation + qualified snapshot gate.
//!
//! Credibility test for the second piece of the cross-protocol
//! contagion proof substrate: a declared bridge reads an upstream
//! component's post-tick observation, applies an explicit transform,
//! and writes a derived oracle update into a downstream component.
//!
//! The test builds a minimal contagion scenario on the shipping
//! liquid-staking and lending bundles without touching the shipping
//! fixtures:
//!
//! 1. `liquid_staking` is the real Sprint 10 depeg + redemption-run
//!    replay — `apply_slash(2500)` at tick 3 drops
//!    `pool.exchange_rate_bps` from 10000 → 7500.
//! 2. `lending` reuses the shipping `lending-whale-bad-debt` adapter
//!    and initial-state (seeded whale positions) but is replayed with
//!    an EMPTY trajectory and NO oracle-trajectory of its own, so the
//!    bridge is the sole oracle source for the lending component.
//! 3. A `bps-ratio` bridge maps LST exchange-rate stress into a
//!    collateral oracle price via `base_price * (obs / denominator)`.
//!
//! The acceptance points the test pins:
//!
//! - The bridge reads the upstream post-tick snapshot and produces a
//!   deterministic downstream oracle update (not a duplicated manual
//!   oracle trajectory).
//! - The write lands on the lending component's oracle BEFORE the
//!   lending component's next tick runs (ordering contract).
//! - A `bridge:<name>` event appears in the simulation result for each
//!   firing, including the pre-slash tick (so reviewers can see the
//!   bridge was evaluated even when the observation hadn't moved yet).
//! - Qualified snapshot keys `<component>.<field>` land on the
//!   timeseries: the proof can refer to
//!   `liquid_staking.pool.exchange_rate_bps`,
//!   `lending.pool.bad_debt`, etc. without ambiguity.
//! - An invariant declared against a qualified key fires as expected.

#![cfg(feature = "litesvm-backend")]
#![cfg(not(doctest))]

use std::{
    fs,
    path::{Path, PathBuf},
};

use riptide_engine::replay::{
    parse_replay_config, run_multi_replay, MultiComponentHarness, ReplayConfigShape,
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

/// Build a minimal downstream lending replay in a temp directory:
/// - same adapter as `fixtures/replays/lending-whale-bad-debt/adapter.toml`
/// - same `initial-state.json` (whale deposits + borrows)
/// - EMPTY `trajectory.json` (no per-tick instructions)
/// - NO `oracle-trajectory.json` — the bridge is the oracle source
fn build_minimal_lending_fixture(dest: &Path) {
    let repo = monorepo_root();
    let lending_src = repo.join("fixtures/replays/lending-whale-bad-debt");
    fs::create_dir_all(dest).expect("create tempdir lending fixture");
    fs::copy(lending_src.join("adapter.toml"), dest.join("adapter.toml"))
        .expect("copy lending adapter.toml");
    fs::copy(
        lending_src.join("initial-state.json"),
        dest.join("initial-state.json"),
    )
    .expect("copy lending initial-state.json");
    let trajectory = r#"{
        "metadata": {
            "name": "contagion-bridge-lending-empty",
            "description": "Downstream lending trajectory used only for bridge-driven oracle writes."
        },
        "ticks": []
    }"#;
    fs::write(dest.join("trajectory.json"), trajectory)
        .expect("write minimal lending trajectory.json");
}

#[test]
fn bridge_propagates_upstream_lst_state_into_downstream_lending_oracle() {
    let repo = monorepo_root();
    let required: &[(PathBuf, &str)] = &[
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
    for (path, label) in required {
        if skip_if_missing(path, label) {
            return;
        }
    }

    let tmpdir = tempfile::tempdir().expect("create tempdir");
    let lending_dir = tmpdir.path().join("lending");
    build_minimal_lending_fixture(&lending_dir);

    let lst_dir = repo.join("fixtures/replays/liquid-staking-depeg-redemption-run");

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
            "bridges": [
                {{ "name": "lst_exchange_rate_to_lending_oracle",
                   "source_component": "liquid_staking",
                   "source_field": "pool.exchange_rate_bps",
                   "target_component": "lending",
                   "target_oracle": "advisory_collateral_feed",
                   "transform": {{ "kind": "bps-ratio",
                                   "base_price": 100.0,
                                   "denominator": 10000.0 }} }}
            ],
            "output_path": "riptide-output/replays/contagion-bridge-smoke"
        }}"#,
        lst = lst_dir.display(),
        lending = lending_dir.display(),
    );

    let shape = parse_replay_config(&raw).expect("parse multi config");
    let cfg = match shape {
        ReplayConfigShape::Multi(cfg) => cfg,
        ReplayConfigShape::Legacy(_) => panic!("expected multi shape"),
    };

    let mut harness = MultiComponentHarness::bootstrap(&cfg, &repo)
        .expect("bootstrap multi-component harness");
    let result = run_multi_replay(&mut harness, "__test__".into())
        .expect("run multi-component replay");

    // ----- Ordering + qualified snapshot contract -----

    // Snapshot for every tick should carry qualified keys for both
    // components. Tick 0 (post-bootstrap) already has these columns.
    let tick_0 = result.timeseries.first().expect("timeseries non-empty");
    assert!(
        tick_0.contains_key("liquid_staking.pool.exchange_rate_bps"),
        "tick 0 snapshot missing qualified LST key; keys: {:?}",
        tick_0.keys().collect::<Vec<_>>()
    );
    assert!(
        tick_0.contains_key("lending.pool.bad_debt"),
        "tick 0 snapshot missing qualified lending key; keys: {:?}",
        tick_0.keys().collect::<Vec<_>>()
    );

    // ----- Shared SimulationResult schema contract -----
    //
    // The CLI schema gate
    // (`cli/src/compiler/schema.ts :: TickSnapshotSchema`,
    //  `SimulationSummarySchema`, `AgentFinalStateSchema`) requires
    // specific engine-owned fields on every replay result. The multi
    // path must satisfy those contracts so T03/T04 can expose the
    // proof through the normal CLI/report flow without the CLI
    // rejecting the payload.
    for (idx, snapshot) in result.timeseries.iter().enumerate() {
        let tick_val = snapshot.get("tick").and_then(|v| v.as_u64());
        assert!(
            tick_val.is_some(),
            "timeseries[{idx}] missing `tick` key; keys: {:?}",
            snapshot.keys().collect::<Vec<_>>()
        );
        let active = snapshot.get("active_agents").and_then(|v| v.as_u64());
        assert!(
            active.is_some(),
            "timeseries[{idx}] missing `active_agents` key; keys: {:?}",
            snapshot.keys().collect::<Vec<_>>()
        );
    }
    for key in ["agents_active", "agents_liquidated", "agents_depleted"] {
        assert!(
            result
                .summary
                .get(key)
                .and_then(|v| v.as_u64())
                .is_some(),
            "summary missing required lifecycle counter `{key}`; keys: {:?}",
            result.summary.keys().collect::<Vec<_>>()
        );
    }

    // Per-component summary rollup contract. The lending half must
    // expose the shipped lending summary keys (`total_bad_debt`,
    // `final_tvl`, `final_utilization`, `largest_single_tick_drawdown`)
    // in the qualified namespace, not snapshot-style aliases. If the
    // multi path ever regresses to writing snapshot metrics under
    // `<component>.summary.*`, downstream consumers would see the
    // WRONG semantics (e.g. `total_bad_debt` would disappear and
    // `pool.bad_debt` would take its place), which is load-bearing
    // for any lending proof.
    for key in [
        "lending.summary.total_bad_debt",
        "lending.summary.final_tvl",
        "lending.summary.final_utilization",
        "lending.summary.largest_single_tick_drawdown",
    ] {
        assert!(
            result.summary.contains_key(key),
            "summary missing required lending summary key `{key}`; keys: {:?}",
            result.summary.keys().collect::<Vec<_>>()
        );
    }
    // LST summary should carry the generic aggregate shape for at
    // least one observation column (e.g. `pool.exchange_rate_bps_avg`).
    let has_lst_generic_summary = result
        .summary
        .keys()
        .any(|k| k.starts_with("liquid_staking.summary.") && k.ends_with("_avg"));
    assert!(
        has_lst_generic_summary,
        "liquid_staking summary missing generic `_avg/_max/_min` aggregates; keys: {:?}",
        result
            .summary
            .keys()
            .filter(|k| k.starts_with("liquid_staking.summary."))
            .collect::<Vec<_>>()
    );
    // Agent finals honor the AgentFinalState wire contract — the
    // status field parses as one of active/liquidated/depleted and
    // counts are real integers, not fabricated placeholders.
    assert!(
        !result.agents.is_empty(),
        "multi replay must emit agent finals for every declared actor"
    );
    for agent in &result.agents {
        assert!(
            !agent.agent_id.is_empty(),
            "agent_id must be non-empty"
        );
        assert!(
            !agent.persona_id.is_empty(),
            "persona_id must be non-empty"
        );
        // Every agent identity field must be namespaced by its
        // component so report surfaces that group by persona_id /
        // persona_label cannot silently merge colliding actor names
        // across components (e.g. two components both shipping
        // `admin-actor` or `user-0`).
        assert!(
            agent.agent_id.starts_with("liquid_staking:")
                || agent.agent_id.starts_with("lending:"),
            "agent_id `{}` must be component-namespaced",
            agent.agent_id
        );
        assert!(
            agent.persona_id.starts_with("liquid_staking:")
                || agent.persona_id.starts_with("lending:"),
            "persona_id `{}` must be component-namespaced",
            agent.persona_id
        );
        assert!(
            agent.persona_label.starts_with("liquid_staking:")
                || agent.persona_label.starts_with("lending:"),
            "persona_label `{}` must be component-namespaced",
            agent.persona_label
        );
        // All replay agents keep the synthetic-replay default Policy;
        // they never update positions, so they stay Active. That's the
        // same honest story the single-component replay path tells.
        assert!(
            matches!(agent.status, riptide_engine::types::AgentStatus::Active),
            "agent {} replay status expected Active, got {:?}",
            agent.agent_id,
            agent.status
        );
    }
    // Event persona_id / persona_label must also namespace by
    // component. Sample a real per-tick event (skip engine-owned
    // synthetic rows like `__engine__`/`__bridge__`).
    let component_event = result
        .events
        .iter()
        .find(|e| !e.persona_id.starts_with("__") && e.persona_id != "bridge")
        .expect("at least one component-dispatched event");
    assert!(
        component_event
            .persona_id
            .starts_with("liquid_staking:")
            || component_event.persona_id.starts_with("lending:"),
        "event persona_id `{}` must be component-namespaced",
        component_event.persona_id
    );
    assert!(
        component_event
            .persona_label
            .starts_with("liquid_staking:")
            || component_event.persona_label.starts_with("lending:"),
        "event persona_label `{}` must be component-namespaced",
        component_event.persona_label
    );
    let declared_total_actions: u32 = result
        .agents
        .iter()
        .map(|a| a.total_actions)
        .sum();
    // total_actions should track real successful dispatches across
    // both components' initial-state + tick trajectories (LST initial
    // state has 5 stakes + `initialize_pool`; lending initial state
    // has 10 deposits+borrows pairs; plus LST's tick instructions).
    assert!(
        declared_total_actions > 0,
        "multi replay emitted zero total_actions across all agents — \
         that would mean trajectory dispatch was not actually tracked"
    );

    // ----- Upstream observation actually moved -----

    let pre_slash = find_snapshot(&result, 2).expect("tick 2 snapshot present");
    let pre_rate = pre_slash
        .get("liquid_staking.pool.exchange_rate_bps")
        .and_then(|v| v.as_f64())
        .expect("pre-slash rate is numeric");
    let post_slash = find_snapshot(&result, 3).expect("tick 3 snapshot present");
    let post_rate = post_slash
        .get("liquid_staking.pool.exchange_rate_bps")
        .and_then(|v| v.as_f64())
        .expect("post-slash rate is numeric");
    assert!(
        (pre_rate - 10000.0).abs() < 1e-6,
        "expected pre-slash exchange_rate_bps = 10000, got {pre_rate}"
    );
    assert!(
        post_rate < pre_rate - 100.0,
        "expected slash to drop exchange_rate_bps meaningfully; pre={pre_rate}, post={post_rate}"
    );

    // ----- Bridge actually fired and propagated the slash -----

    // Pre-slash (tick 2): bridge computes 100 * (rate/10000)
    let pre_bridge_price = pre_slash
        .get("lending.oracle_price")
        .and_then(|v| v.as_f64())
        .expect("pre-slash lending oracle_price is numeric");
    let expected_pre = 100.0 * (pre_rate / 10000.0);
    assert!(
        (pre_bridge_price - expected_pre).abs() < 1e-6,
        "pre-slash bridge should drive lending oracle to {expected_pre}, got {pre_bridge_price}"
    );

    // Post-slash (tick 3): bridge recomputes 100 * (post_rate/10000)
    let post_bridge_price = post_slash
        .get("lending.oracle_price")
        .and_then(|v| v.as_f64())
        .expect("post-slash lending oracle_price is numeric");
    let expected_post = 100.0 * (post_rate / 10000.0);
    assert!(
        (post_bridge_price - expected_post).abs() < 1e-6,
        "post-slash bridge should drive lending oracle to {expected_post}, \
         got {post_bridge_price}; pre={pre_bridge_price}, post-rate={post_rate}"
    );

    // The downstream oracle value at tick 3 must not equal the value
    // at tick 2 — otherwise we have coincidence, not propagation.
    assert!(
        (post_bridge_price - pre_bridge_price).abs() > 0.5,
        "bridge produced the same price before and after the slash; \
         downstream oracle is not responding to upstream state"
    );

    // ----- Bridge fired every tick with a per-firing event -----

    let bridge_events: Vec<&riptide_engine::types::SimEvent> = result
        .events
        .iter()
        .filter(|e| e.action == "bridge:lst_exchange_rate_to_lending_oracle")
        .collect();
    assert!(
        bridge_events.len() >= 2,
        "expected bridge to fire on multiple ticks (incl. pre and post slash), got {} events",
        bridge_events.len()
    );
    // Every bridge event must identify source/target and carry the
    // observation it read.
    for event in &bridge_events {
        assert_eq!(
            event.params.get("source_component").and_then(|v| v.as_str()),
            Some("liquid_staking")
        );
        assert_eq!(
            event.params.get("target_component").and_then(|v| v.as_str()),
            Some("lending")
        );
        assert!(
            event.params.contains_key("observation"),
            "bridge event missing observation field"
        );
        assert!(
            event.params.contains_key("derived_price"),
            "bridge event missing derived_price field"
        );
    }

    // ----- Qualified invariant surface fires on the downstream -----

    // The lending adapter declares `no_bad_debt` on field `bad_debt`.
    // In the qualified namespace that becomes `lending.pool.bad_debt`,
    // which at tick 0 (post-bootstrap initial borrows) is zero and
    // stays zero across the whole run of this minimal fixture (no
    // liquidations are scheduled in the trimmed trajectory). The
    // invariant therefore does NOT fire, and the `invariants_fired`
    // summary row must show firings = 0. This is the negative-case
    // half of the qualified-surface contract: the engine can read
    // `lending.pool.bad_debt` from the qualified snapshot, the
    // invariant is evaluated against it, and an honest "no firing"
    // is recorded. The end-to-end "invariant fires because of the
    // bridge" case is T04's named contagion proof.
    let invariants = result
        .summary
        .get("invariants_fired")
        .and_then(|v| v.as_array())
        .expect("invariants_fired rollup present");
    let lending_no_bad_debt = invariants
        .iter()
        .find(|row| {
            row.get("field")
                .and_then(|v| v.as_str())
                .map(|s| s == "lending.pool.bad_debt")
                .unwrap_or(false)
        })
        .unwrap_or_else(|| {
            panic!(
                "no invariant targeting `lending.pool.bad_debt` in {invariants:?}"
            )
        });
    let firings = lending_no_bad_debt
        .get("firings")
        .and_then(|v| v.as_u64())
        .unwrap();
    assert_eq!(
        firings, 0,
        "lending.no_bad_debt should not fire in the bridge-only smoke test; \
         firings={firings}"
    );

    // `no_slash_during_healthy_run` is declared on the LST adapter and
    // gets qualified to `liquid_staking.pool.cumulative_slashed`. The
    // slash at tick 3 makes it fire.
    let lst_slash = invariants
        .iter()
        .find(|row| {
            row.get("field")
                .and_then(|v| v.as_str())
                .map(|s| s == "liquid_staking.pool.cumulative_slashed")
                .unwrap_or(false)
        })
        .unwrap_or_else(|| {
            panic!(
                "no invariant targeting `liquid_staking.pool.cumulative_slashed` \
                 in {invariants:?}"
            )
        });
    let firings = lst_slash
        .get("firings")
        .and_then(|v| v.as_u64())
        .unwrap();
    assert!(
        firings > 0,
        "no_slash_during_healthy_run must fire post-slash on qualified LST field; \
         firings={firings}"
    );
}

fn find_snapshot<'a>(
    result: &'a riptide_engine::types::SimulationResult,
    tick: u32,
) -> Option<&'a riptide_engine::types::TickSnapshot> {
    result
        .timeseries
        .iter()
        .find(|s| s.get("tick").and_then(|v| v.as_u64()).map(|t| t as u32) == Some(tick))
}

/// CLI reachability gate. Proves the `riptide-engine replay --config`
/// flag routes a multi-component config through the binary end-to-end
/// — writes a valid `SimulationResult` JSON, exits cleanly, and
/// satisfies the shared wire contract (lifecycle counters, component-
/// qualified summary keys, namespaced agent identities). Without
/// this, the Phase 1 substrate would only be reachable from Rust
/// tests and the CLI/report flow in T03/T04 would hit a hard wall.
#[test]
fn engine_replay_config_flag_drives_multi_component_replay_end_to_end() {
    let repo = monorepo_root();
    let required: &[(PathBuf, &str)] = &[
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
    for (path, label) in required {
        if skip_if_missing(path, label) {
            return;
        }
    }

    let tmpdir = tempfile::tempdir().expect("create tempdir");
    let lending_dir = tmpdir.path().join("lending");
    build_minimal_lending_fixture(&lending_dir);

    let lst_dir = repo.join("fixtures/replays/liquid-staking-depeg-redemption-run");

    let config_path = tmpdir.path().join("contagion-smoke-config.json");
    let config_body = format!(
        r#"{{
            "components": [
                {{ "name": "liquid_staking",
                   "adapter": "{lst}/adapter.toml",
                   "trajectory_dir": "{lst}" }},
                {{ "name": "lending",
                   "adapter": "{lending}/adapter.toml",
                   "trajectory_dir": "{lending}" }}
            ],
            "bridges": [
                {{ "name": "lst_exchange_rate_to_lending_oracle",
                   "source_component": "liquid_staking",
                   "source_field": "pool.exchange_rate_bps",
                   "target_component": "lending",
                   "target_oracle": "advisory_collateral_feed",
                   "transform": {{ "kind": "bps-ratio",
                                   "base_price": 100.0,
                                   "denominator": 10000.0 }} }}
            ],
            "output_path": "riptide-output/replays/contagion-bridge-cli-smoke"
        }}"#,
        lst = lst_dir.display(),
        lending = lending_dir.display(),
    );
    fs::write(&config_path, config_body).expect("write multi config");

    let output = tmpdir.path().join("result.json");
    // The CARGO_BIN_EXE_<name> env var is injected by Cargo when
    // integration tests compile against this crate's binary target.
    let binary = std::path::PathBuf::from(env!("CARGO_BIN_EXE_riptide-engine"));
    let status = std::process::Command::new(&binary)
        .arg("replay")
        .arg("--config")
        .arg(&config_path)
        .arg("--output")
        .arg(&output)
        .arg("--allow-invariant-violations")
        .status()
        .expect("spawn riptide-engine");
    assert!(
        status.success(),
        "`riptide-engine replay --config {}` exited {status:?}",
        config_path.display()
    );

    // Parse the binary's output through the same wire contract the
    // CLI/report flow will consume in T04.
    let raw = fs::read_to_string(&output).expect("read engine output");
    let result: riptide_engine::types::SimulationResult =
        serde_json::from_str(&raw).expect("engine output must be a valid SimulationResult");

    assert!(
        result.scenario().starts_with("replay:multi:"),
        "expected multi-component scenario tag, got `{}`",
        result.scenario()
    );
    // Schema contract the CLI Zod guard will apply.
    assert!(
        result.summary.get("agents_active").is_some(),
        "binary-produced summary missing `agents_active`"
    );
    assert!(
        result.summary.contains_key("lending.summary.total_bad_debt"),
        "binary-produced summary missing `lending.summary.total_bad_debt`; keys: {:?}",
        result.summary.keys().collect::<Vec<_>>()
    );
    // Every snapshot carries `tick` + `active_agents`.
    for (idx, snapshot) in result.timeseries.iter().enumerate() {
        assert!(
            snapshot.contains_key("tick"),
            "binary-produced snapshot[{idx}] missing `tick`"
        );
        assert!(
            snapshot.contains_key("active_agents"),
            "binary-produced snapshot[{idx}] missing `active_agents`"
        );
    }
}

// Small extension trait so the CLI-binary test above can reach the
// scenario field without rewriting this whole file.
trait ScenarioAccess {
    fn scenario(&self) -> &str;
}

impl ScenarioAccess for riptide_engine::types::SimulationResult {
    fn scenario(&self) -> &str {
        self.run_config.scenario.as_str()
    }
}
