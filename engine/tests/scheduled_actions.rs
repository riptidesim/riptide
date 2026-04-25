//! Engine-Triggered Scheduled Actions
//!
//! End-to-end coverage for the declarative `[[scheduled_actions]]`
//! adapter block and the tick-loop scheduler dispatch.
//!
//! Covered:
//! 1. Adapter TOML parse of `[[scheduled_actions]]`, including
//! malformed input rejection (unknown instruction, zero interval).
//! 2. Scheduling: interval=5 over 30 ticks fires exactly 6 times
//! (ticks 5, 10, 15, 20, 25, 30).
//! 3. Deterministic ordering when two scheduled actions overlap on
//! the same tick (intervals 3 and 5).
//! 4. Determinism across back-to-back same-seed runs.
//! 5. Backwards compat: an adapter with no `[[scheduled_actions]]`
//! block runs without firing anything.

use std::collections::BTreeMap;

use riptide_engine::{
    adapter::{loader::parse_adapter_str, ScheduledAction},
    agent::policy::LENDING_RUNTIME_ACTIONS,
    scenario::BaselineScenario,
    sim::{run_simulation, MockHarness, SimulationParams},
    types::{
        Policy, PositionSizing, PositionSizingStrategy, RunConfig, SimEvent, SimOutcome,
        SimulationResult, Trigger, TriggerCondition,
    },
};

fn policy() -> Policy {
    Policy {
        persona_id: "sched-lp".into(),
        persona_label: "sched-lp".into(),
        action_rate_multiplier: 1.0,
        risk_tolerance: 0.5,
        action_weights: BTreeMap::from([
            ("deposit".into(), 0.9),
            ("borrow".into(), 0.1),
            ("withdraw".into(), 0.0),
            ("repay".into(), 0.0),
            ("liquidate".into(), 0.0),
        ]),
        triggers: vec![Trigger {
            condition: TriggerCondition::PriceDropPercent { threshold: 0.9 },
            response: "hold".into(),
            severity: 1,
            cooldown_ticks: 1,
            weight_boost: None,
        }],
        position_sizing: PositionSizing {
            strategy: PositionSizingStrategy::Fixed,
            params: BTreeMap::from([("amount".into(), 100.0)]),
        },
        max_exposure: 0.8,
        persona_args: BTreeMap::new(),
    }
}

fn run_with(ticks: u32, scheduled_actions: Vec<ScheduledAction>) -> SimulationResult {
    let cfg = RunConfig {
        agents: 2,
        ticks,
        scenario: "baseline".into(),
        seed: 17,
        personas: vec!["sched-lp".into()],
        validator_url: "unused".into(),
        output_path: "unused".into(),
    };
    let mut harness = MockHarness::new(cfg.agents as usize, 100.0);
    let mut scenario = BaselineScenario::new(100.0, 0);
    let params = SimulationParams {
        run_config: &cfg,
        policies: vec![policy()],
        agent_personas: vec![0; cfg.agents as usize],
        available_actions: LENDING_RUNTIME_ACTIONS.to_vec(),
        starting_balance: 10_000.0,
        starting_price: 100.0,
        simulation_boundaries: vec!["t19 scheduled".into()],
        invariants: Vec::new(),
        scheduled_actions,
    };
    run_simulation(&mut harness, &mut scenario, params).unwrap()
}

fn scheduled_events(result: &SimulationResult) -> Vec<&SimEvent> {
    result
        .events
        .iter()
        .filter(|e| e.agent_id == "__engine__" && e.persona_id == "scheduled")
        .collect()
}

// ---------------------------------------------------------------------------
// Adapter parse + validation
// ---------------------------------------------------------------------------

#[test]
fn adapter_parses_scheduled_actions_block() {
    let toml = r#"
protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"

[[scheduled_actions]]
name = "funding_accrual"
instruction = "deposit"
interval_ticks = 8

[[scheduled_actions]]
instruction = "deposit"
interval_ticks = 1
"#;
    let adapter = parse_adapter_str(toml, "test.toml").expect("parse");
    assert_eq!(adapter.scheduled_actions.len(), 2);
    assert_eq!(
        adapter.scheduled_actions[0].name.as_deref(),
        Some("funding_accrual")
    );
    assert_eq!(adapter.scheduled_actions[0].interval_ticks, 8);
    assert!(adapter.scheduled_actions[1].name.is_none());
    assert_eq!(
        adapter.scheduled_actions[1].display_name(1),
        "scheduled_1"
    );
}

#[test]
fn adapter_rejects_unknown_instruction_reference() {
    let toml = r#"
protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"

[[scheduled_actions]]
instruction = "not_a_real_ix"
interval_ticks = 5
"#;
    let err = parse_adapter_str(toml, "test.toml").unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("[[scheduled_actions]][0].instruction"),
        "error should name the offending key: {msg}"
    );
    assert!(msg.contains("not_a_real_ix"), "got: {msg}");
    // -style actionable message — names the declared set.
    assert!(msg.contains("[instructions]"), "got: {msg}");
}

#[test]
fn adapter_rejects_zero_interval() {
    let toml = r#"
protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"

[[scheduled_actions]]
instruction = "deposit"
interval_ticks = 0
"#;
    let err = parse_adapter_str(toml, "test.toml").unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("interval_ticks"),
        "error should name the offending field: {msg}"
    );
    assert!(msg.contains("positive"), "got: {msg}");
}

// ---------------------------------------------------------------------------
// Tick-loop scheduling
// ---------------------------------------------------------------------------

/// Drive the mock harness through a fresh run and return the harness
/// afterwards so tests can inspect primitive-level side effects (e.g.
/// `scheduled_action_calls`). Mirrors [`run_with`] but returns the
/// harness alongside the result.
fn run_with_harness(
    ticks: u32,
    scheduled_actions: Vec<ScheduledAction>,
) -> (SimulationResult, MockHarness) {
    let cfg = RunConfig {
        agents: 2,
        ticks,
        scenario: "baseline".into(),
        seed: 17,
        personas: vec!["sched-lp".into()],
        validator_url: "unused".into(),
        output_path: "unused".into(),
    };
    let mut harness = MockHarness::new(cfg.agents as usize, 100.0);
    let mut scenario = BaselineScenario::new(100.0, 0);
    let params = SimulationParams {
        run_config: &cfg,
        policies: vec![policy()],
        agent_personas: vec![0; cfg.agents as usize],
        available_actions: LENDING_RUNTIME_ACTIONS.to_vec(),
        starting_balance: 10_000.0,
        starting_price: 100.0,
        simulation_boundaries: vec!["t19 scheduled".into()],
        invariants: Vec::new(),
        scheduled_actions,
    };
    let result = run_simulation(&mut harness, &mut scenario, params).unwrap();
    (result, harness)
}

#[test]
fn scheduler_fires_every_n_ticks_exactly() {
    // interval=5 over 30 ticks should fire at ticks 5,10,15,20,25,30 = 6 times.
    let sa = ScheduledAction {
        name: Some("fund_rate".into()),
        instruction: "deposit".into(),
        interval_ticks: 5,
        accounts: Vec::new(),
        args: BTreeMap::new(),
    };
    let (result, harness) = run_with_harness(30, vec![sa]);
    let events = scheduled_events(&result);
    assert_eq!(
        events.len(),
        6,
        "expected 6 scheduled firings at interval 5 over 30 ticks, got {}: {:?}",
        events.len(),
        events.iter().map(|e| e.tick).collect::<Vec<_>>()
    );
    let ticks: Vec<u32> = events.iter().map(|e| e.tick).collect();
    assert_eq!(ticks, vec![5, 10, 15, 20, 25, 30]);
    for e in &events {
        assert_eq!(e.outcome, SimOutcome::Success);
        assert_eq!(e.action, "scheduled:fund_rate");
        assert_eq!(e.params["instruction"], "deposit");
    }

    // (review fix #3): the primitive-level hook must
    // observe every firing, not just the event stream. MockHarness
    // increments a counter in `on_scheduled_action`, and the total
    // must equal the number of events the tick loop emitted. This is
    // what makes "the engine INVOKES the declared instruction" a
    // real claim — a consumer that never reads SimEvent[] can still
    // observe the primitive-side effect.
    assert_eq!(
        harness.scheduled_action_calls("fund_rate"),
        6,
        "primitive hook must be invoked once per scheduled firing"
    );
    assert_eq!(harness.total_scheduled_action_calls(), 6);
}

#[test]
fn scheduler_respects_declaration_order_on_overlapping_ticks() {
    // Intervals 3 and 5 collide at tick 15 and the end of every LCM
    // interval. Declaration order must be the tiebreak so the event
    // stream is reproducible across runs.
    let sa_a = ScheduledAction {
        name: Some("a_every_3".into()),
        instruction: "deposit".into(),
        interval_ticks: 3,
        accounts: Vec::new(),
        args: BTreeMap::new(),
    };
    let sa_b = ScheduledAction {
        name: Some("b_every_5".into()),
        instruction: "deposit".into(),
        interval_ticks: 5,
        accounts: Vec::new(),
        args: BTreeMap::new(),
    };
    let result = run_with(15, vec![sa_a, sa_b]);
    let events = scheduled_events(&result);

    // tick 15 should have both, with a_every_3 first (declaration order).
    let at_15: Vec<&&SimEvent> = events.iter().filter(|e| e.tick == 15).collect();
    assert_eq!(at_15.len(), 2, "both scheduled actions due at tick 15");
    assert_eq!(at_15[0].action, "scheduled:a_every_3");
    assert_eq!(at_15[1].action, "scheduled:b_every_5");
}

#[test]
fn scheduler_is_deterministic_across_same_seed_runs() {
    // Same seed, same scheduled actions → byte-identical event sequence.
    let make = || vec![
        ScheduledAction {
            name: Some("a".into()),
            instruction: "deposit".into(),
            interval_ticks: 3,
            accounts: Vec::new(),
            args: BTreeMap::new(),
        },
        ScheduledAction {
            name: Some("b".into()),
            instruction: "deposit".into(),
            interval_ticks: 5,
            accounts: Vec::new(),
            args: BTreeMap::new(),
        },
    ];
    let r1 = run_with(20, make());
    let r2 = run_with(20, make());
    let e1: Vec<_> = scheduled_events(&r1)
        .iter()
        .map(|e| (e.tick, e.action.clone()))
        .collect();
    let e2: Vec<_> = scheduled_events(&r2)
        .iter()
        .map(|e| (e.tick, e.action.clone()))
        .collect();
    assert_eq!(e1, e2, "scheduled sequence diverged across same-seed runs");
}

#[test]
fn no_scheduled_actions_declared_leaves_event_stream_clean() {
    let result = run_with(5, Vec::new());
    let events = scheduled_events(&result);
    assert!(
        events.is_empty(),
        "zero scheduled_actions → zero engine-owned scheduled events: {:?}",
        events
    );
    // Byte-identical shape guard (matches the determinism contract).
    let json = serde_json::to_string(&result).expect("serialize");
    assert!(
        !json.contains("\"scheduled:"),
        "serialized output must omit `scheduled:` events when none declared"
    );
}

#[test]
fn lending_adapter_parses_without_scheduled_actions() {
    let solend_toml = include_str!("../../fixtures/adapters/lending.toml");
    let adapter = parse_adapter_str(solend_toml, "lending.toml").expect("parse");
    assert!(
        adapter.scheduled_actions.is_empty(),
        "lending.toml must default to zero scheduled actions"
    );
}
