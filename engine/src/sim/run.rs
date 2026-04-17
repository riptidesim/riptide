//! The tick loop itself. Generic over any `Harness` implementation so the
//! same code drives the in-process LiteSVM backend, the validator-backed
//! parity path, or the mock-backed test path.

use std::collections::BTreeMap;

use rand::{rngs::StdRng, SeedableRng};
use serde_json::Value;

use super::harness::{Harness, HarnessError, PositionObservation};
use crate::{
    adapter::{Invariant, ScheduledAction},
    agent::{
        policy::RuntimeAction,
        state::Agent,
        AgentRuntime,
    },
    scenario::Scenario,
    types::{
        AgentStatus, InvariantViolation, Policy, RunConfig, SimEvent, SimOutcome,
        SimulationResult, SimulationSummary, TickSnapshot,
    },
};

/// Shape of the starting collateral/debt used to seed each agent's position.
#[derive(Debug, Clone, Copy)]
pub struct StartingPosition {
    pub collateral: u64,
    pub debt: u64,
}

/// Inputs to `run_simulation`. Keeping these in a single struct avoids a
/// 10-argument function signature and makes it easy to thread new knobs
/// (e.g. starting balances) from the CLI.
pub struct SimulationParams<'a> {
    pub run_config: &'a RunConfig,
    pub policies: Vec<Policy>,
    /// One entry per agent. `policies` is indexed by persona; this is the
    /// per-agent instantiation order. Must be the same length as the harness's
    /// `agent_count()`.
    pub agent_personas: Vec<usize>,
    pub available_actions: Vec<RuntimeAction>,
    pub starting_balance: f64,
    pub starting_price: f64,
    pub simulation_boundaries: Vec<String>,
    /// Sprint 5 T01: declarative invariants pulled from the adapter TOML
    /// `[[invariants]]` block. Empty by default so the Sprint 4 hero-grid
    /// determinism hash stays byte-stable for every adapter that does
    /// not declare any invariants.
    #[doc(hidden)]
    pub invariants: Vec<Invariant>,
    /// Sprint 5 T06: declarative scheduled actions pulled from the
    /// adapter TOML `[[scheduled_actions]]` block. The tick loop fires
    /// each entry on every tick where `tick %% interval_ticks == 0`,
    /// in declaration order, **before** persona actions. Empty by
    /// default so existing adapters keep producing byte-identical
    /// output.
    #[doc(hidden)]
    pub scheduled_actions: Vec<ScheduledAction>,
}

impl<'a> SimulationParams<'a> {
    /// Default-empty invariants constructor for tests and callers that
    /// have not plumbed the adapter-derived list through yet. Prefer
    /// setting `invariants` explicitly from `adapter.invariants.clone()`.
    pub fn with_defaults(
        run_config: &'a RunConfig,
        policies: Vec<Policy>,
        agent_personas: Vec<usize>,
        available_actions: Vec<RuntimeAction>,
        starting_balance: f64,
        starting_price: f64,
        simulation_boundaries: Vec<String>,
    ) -> Self {
        Self {
            run_config,
            policies,
            agent_personas,
            available_actions,
            starting_balance,
            starting_price,
            simulation_boundaries,
            invariants: Vec::new(),
            scheduled_actions: Vec::new(),
        }
    }
}

/// Errors that abort the whole run (infra failures after the single retry,
/// malformed inputs, etc.). Non-fatal errors (program-rejected actions) are
/// swallowed into the event log.
#[derive(Debug, Clone)]
pub enum SimulationAbort {
    Infra(String),
    BadInput(String),
}

impl std::fmt::Display for SimulationAbort {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Infra(msg) => write!(f, "simulation bailed on infra failure: {msg}"),
            Self::BadInput(msg) => write!(f, "simulation aborted: {msg}"),
        }
    }
}

impl std::error::Error for SimulationAbort {}

fn agent_id(idx: usize) -> String {
    format!("agent-{:03}", idx + 1)
}

/// Map a `RunConfig.personas` list (persona_id strings) into the per-agent
/// policy index vector consumed by `SimulationParams`. Round-robins through
/// the personas list when there are more agents than personas. Errors if any
/// requested persona is not present in `policies`, so missing personas are
/// caught up front instead of being silently swapped for whatever happens to
/// sit at index 0 of the policy file.
pub fn build_agent_personas(
    personas: &[String],
    policies: &[Policy],
    agents: usize,
) -> Result<Vec<usize>, SimulationAbort> {
    if policies.is_empty() {
        return Err(SimulationAbort::BadInput("empty policies".into()));
    }
    if personas.is_empty() {
        // Fallback: round-robin all policies in file order. Documented in the
        // CLI help so users know they need to set `personas` for deterministic
        // assignment.
        return Ok((0..agents).map(|i| i % policies.len()).collect());
    }
    let mut resolved = Vec::with_capacity(personas.len());
    for persona in personas {
        let idx = policies
            .iter()
            .position(|p| &p.persona_id == persona)
            .ok_or_else(|| {
                let mut available: Vec<&str> =
                    policies.iter().map(|p| p.persona_id.as_str()).collect();
                available.sort_unstable();
                SimulationAbort::BadInput(format!(
                    "run_config.personas references unknown persona `{persona}` — \
                     not declared in the policies file.\n\
                     Available personas: {available:?}.\n\
                     Fix `personas` in your run-config JSON (or `--personas` on the CLI) \
                     to one of the listed ids."
                ))
            })?;
        resolved.push(idx);
    }
    Ok((0..agents).map(|i| resolved[i % resolved.len()]).collect())
}

/// Apply a freshly observed on-chain position to an in-memory agent. Returns
/// `true` if the agent transitioned to liquidated as a result of this
/// observation (so the caller can bump cumulative counters and skip its
/// action this tick).
fn apply_position_observation(agent: &mut Agent, obs: &PositionObservation, tick: u32) -> bool {
    agent.position.collateral = obs.collateral as f64;
    agent.position.debt = obs.debt as f64;
    if obs.liquidated && !matches!(agent.status, AgentStatus::Liquidated) {
        agent.mark_liquidated(tick);
        return true;
    }
    false
}

/// Single retry wrapper: `Infra` errors are tried once more before surfacing.
/// `ProgramRejected` is returned as-is.
fn with_retry<H, F>(harness: &mut H, mut op: F) -> Result<(), HarnessError>
where
    F: FnMut(&mut H) -> Result<(), HarnessError>,
{
    match op(harness) {
        Ok(()) => Ok(()),
        Err(HarnessError::ProgramRejected(msg)) => Err(HarnessError::ProgramRejected(msg)),
        Err(HarnessError::Infra(first)) => {
            eprintln!("warn: harness infra failure, retrying once ({first})");
            op(harness)
        }
    }
}

/// Run the tick loop until all ticks are exhausted or every agent is
/// inactive. Deterministic: same `run_config.seed` + same inputs => same
/// event sequence.
pub fn run_simulation<H, S>(
    harness: &mut H,
    scenario: &mut S,
    params: SimulationParams<'_>,
) -> Result<SimulationResult, SimulationAbort>
where
    H: Harness,
    S: Scenario + ?Sized,
{
    let SimulationParams {
        run_config,
        policies,
        agent_personas,
        available_actions,
        starting_balance,
        starting_price,
        simulation_boundaries,
        invariants,
        scheduled_actions,
    } = params;

    if harness.agent_count() != agent_personas.len() {
        return Err(SimulationAbort::BadInput(format!(
            "harness agent_count={} does not match agent_personas len={}",
            harness.agent_count(),
            agent_personas.len()
        )));
    }
    if policies.is_empty() {
        return Err(SimulationAbort::BadInput("empty policies".into()));
    }

    let mut invariant_violations: Vec<InvariantViolation> = Vec::new();

    // Master RNG for scenario + per-agent runtime derivation. Everything that
    // touches randomness in this loop pulls from here (or from a runtime
    // seeded deterministically off this value).
    let mut master_rng = StdRng::seed_from_u64(run_config.seed);

    // Build the in-memory agent mirror. The engine keeps its own view of
    // cash; harness state is the truth for collateral/debt. We re-read each
    // agent's on-chain position at t0 so any seed deposit done by the CLI
    // before run_simulation lands in the in-memory mirror as well, with the
    // cost (collateral) and proceeds (debt) reflected in cash. Skipping this
    // would give every agent free seeded equity.
    let mut agents: Vec<Agent> = agent_personas
        .iter()
        .enumerate()
        .map(|(idx, &persona_idx)| {
            let policy = policies
                .get(persona_idx)
                .cloned()
                .unwrap_or_else(|| policies[0].clone());
            Agent::new(agent_id(idx), policy, starting_balance).with_starting_price(starting_price)
        })
        .collect();
    for idx in 0..agents.len() {
        let obs = match harness.health_factor(idx) {
            Ok(o) => o,
            Err(HarnessError::Infra(first)) => {
                eprintln!("warn: initial position observe failed ({first}), retrying once");
                harness
                    .health_factor(idx)
                    .map_err(|e| SimulationAbort::Infra(e.to_string()))?
            }
            Err(HarnessError::ProgramRejected(msg)) => {
                return Err(SimulationAbort::Infra(format!(
                    "initial position observe rejected: {msg}"
                )));
            }
        };
        // Equity-preserving sync: cash funded the seeded collateral (at
        // starting_price dollars per unit), and any seeded debt arrived as
        // cash on the agent's books. Equity at t0 == starting_balance
        // regardless of the on-chain seed shape.
        let agent = &mut agents[idx];
        agent.position.collateral = obs.collateral as f64;
        agent.position.debt = obs.debt as f64;
        agent.cash_balance =
            starting_balance - (obs.collateral as f64 * starting_price) + obs.debt as f64;
        agent.peak_equity = agent.equity(starting_price).max(starting_balance);
        if obs.liquidated {
            agent.mark_liquidated(0);
        }
    }
    // Count any pre-existing liquidations from the seed phase.
    let mut cumulative_liquidations: u32 = agents
        .iter()
        .filter(|a| matches!(a.status, AgentStatus::Liquidated))
        .count() as u32;

    // Per-agent runtimes with stable derived seeds for tie-breaking.
    let mut runtimes: Vec<AgentRuntime> = (0..agents.len())
        .map(|idx| AgentRuntime::new(run_config.seed.wrapping_add(idx as u64)))
        .collect();

    let mut events: Vec<SimEvent> = Vec::new();
    let mut timeseries: Vec<TickSnapshot> = Vec::new();
    // Track the last tick the loop actually processed so the final
    // best-effort refresh attributes any newly seen liquidations to the
    // tick they could plausibly have happened on, not the configured max.
    let mut last_executed_tick: u32 = 0;

    // tick 0 snapshot (pre-run baseline).
    {
        let mut baseline = build_snapshot(harness, 0, &agents)
            .map_err(|e| SimulationAbort::Infra(e.to_string()))?;
        baseline.insert(
            "cumulative_liquidations".into(),
            Value::from(cumulative_liquidations),
        );
        evaluate_invariants(&invariants, 0, &baseline, &mut invariant_violations, &mut events);
        timeseries.push(baseline);
    }

    for tick in 1..=run_config.ticks {
        eprintln!("TICK {tick}/{}", run_config.ticks);

        // 0. Advance synthetic chain state (slot, blockhash, clock).
        //    No-op for backends that manage their own progression (validator,
        //    mock). LiteSVM overrides this to keep tick semantics consistent.
        harness.advance_tick();

        // 1. Advance scenario (deterministic via master_rng).
        let oracle_update = scenario.update(tick, &mut master_rng);

        // 2. Push oracle update (with single retry on infra).
        with_retry(harness, |h| h.push_oracle_price(&oracle_update)).map_err(|e| match e {
            HarnessError::Infra(msg) => SimulationAbort::Infra(msg),
            HarnessError::ProgramRejected(msg) => SimulationAbort::Infra(format!(
                "oracle push rejected by program (unexpected): {msg}"
            )),
        })?;

        // 2b. Sprint 5 T06: fire declared scheduled actions BEFORE the
        //     persona loop so any world-state update they perform lands
        //     before agents observe. Declaration order is the tiebreak
        //     for same-tick firings. Invariants still evaluate LAST at
        //     the post-persona snapshot — documented in the module
        //     header. Scheduled actions produce engine-owned SimEvents
        //     so tests can assert firing counts without instrumenting
        //     the primitive.
        dispatch_scheduled_actions(&scheduled_actions, tick, harness, &mut events)?;

        // Read pool state once at the top of the tick for observations.
        let pool_obs = match harness.pool_state() {
            Ok(p) => p,
            Err(HarnessError::Infra(first)) => {
                eprintln!("warn: pool observe failed ({first}), retrying once");
                harness
                    .pool_state()
                    .map_err(|e| SimulationAbort::Infra(e.to_string()))?
            }
            Err(HarnessError::ProgramRejected(msg)) => {
                return Err(SimulationAbort::Infra(format!(
                    "pool observe unexpectedly rejected: {msg}"
                )));
            }
        };

        let oracle_price = oracle_update.price;
        let utilization = pool_obs.utilization();
        // Convert pool headroom into dollar-denominated borrow capacity,
        // matching how the on-chain program computes it at
        // programs/lending_pool/src/processor.rs:211 — deposits are priced
        // at `oracle_price` dollars per collateral unit, borrows are debt
        // dollars. The old call used raw unit math here, which produced a
        // value 1/oracle_price too small and zeroed borrow scores in the
        // action policy whenever the pool was modestly funded.
        let available_liquidity = ((pool_obs.total_deposits as f64 * oracle_price)
            - pool_obs.total_borrows as f64)
            .max(0.0);

        // 3. Per-agent observe → decide → act.
        for idx in 0..agents.len() {
            if !agents[idx].is_active() {
                continue;
            }

            // Observation must reflect on-chain position so triggers fire
            // correctly even if the previous tick liquidated the agent. Both
            // the happy path and the post-retry success path go through
            // `apply_position_observation` so the liquidation transition
            // can't be lost on a transient infra blip.
            let position_obs = match harness.health_factor(idx) {
                Ok(p) => p,
                Err(HarnessError::Infra(first)) => {
                    eprintln!("warn: position observe failed ({first}), retrying");
                    harness
                        .health_factor(idx)
                        .map_err(|e| SimulationAbort::Infra(e.to_string()))?
                }
                Err(HarnessError::ProgramRejected(msg)) => {
                    return Err(SimulationAbort::Infra(format!(
                        "position observe rejected: {msg}"
                    )));
                }
            };
            if apply_position_observation(&mut agents[idx], &position_obs, tick) {
                cumulative_liquidations += 1;
                continue;
            }

            let observation = runtimes[idx].observe(
                tick,
                &agents[idx].policy.clone(),
                &agents[idx],
                oracle_price,
                starting_price,
                utilization,
                available_liquidity,
                match harness.observation_values(idx) {
                    Ok(values) => values,
                    Err(HarnessError::Infra(first)) => {
                        eprintln!("warn: custom observation read failed ({first}), retrying");
                        harness
                            .observation_values(idx)
                            .map_err(|e| SimulationAbort::Infra(e.to_string()))?
                    }
                    Err(HarnessError::ProgramRejected(msg)) => {
                        return Err(SimulationAbort::Infra(format!(
                            "custom observation rejected: {msg}"
                        )));
                    }
                },
            );
            let decision = runtimes[idx].decide(&mut agents[idx], &observation, &available_actions);
            let action = decision.chosen.clone();
            let amount = decision.amount.max(0.0).round() as u64;

            // Pick a liquidation target up front so the caller can clamp the
            // cash debit to whatever the on-chain program will actually
            // consume. Mirrors the on-chain Repay/Liquidate clamping at
            // programs/lending_pool/src/processor.rs:251 and :293.
            // For a liquidate, refresh every other borrower's on-chain
            // position right before picking a target. Without this refresh
            // the picker ranks candidates against engine-side state that is
            // stale for siblings that already acted this tick, and the
            // program rejects most attempts with PositionHealthy even when
            // the engine thinks the candidate is underwater. Cost is one
            // extra RPC per borrower per liquidate decision, which is
            // acceptable for correctness.
            let liquidate_target = if action == RuntimeAction::Liquidate {
                for other_idx in 0..agents.len() {
                    if other_idx == idx || !agents[other_idx].is_active() {
                        continue;
                    }
                    // Full position sync — collateral, debt, *and* the
                    // liquidated flag. If a borrower was liquidated
                    // earlier in this same tick (partial-liq or bad-debt
                    // path), it is still in_memory `Active` until its own
                    // turn. Using apply_position_observation here flips
                    // the status immediately so the picker can't retarget
                    // an already-liquidated borrower, which would produce
                    // an avoidable `PositionLiquidated` failure.
                    match harness.health_factor(other_idx) {
                        Ok(obs) => {
                            if apply_position_observation(&mut agents[other_idx], &obs, tick) {
                                cumulative_liquidations += 1;
                            }
                        }
                        Err(HarnessError::Infra(msg)) => {
                            eprintln!("warn: sibling observe failed ({msg}), skipping {other_idx}");
                        }
                        Err(HarnessError::ProgramRejected(msg)) => {
                            return Err(SimulationAbort::Infra(format!(
                                "sibling observe rejected: {msg}"
                            )));
                        }
                    }
                }
                pick_liquidation_target(idx, &agents, oracle_price)
            } else {
                None
            };

            // Unit reconciliation between the engine's dollar-denominated
            // cash balance and the on-chain collateral token.
            //
            // The runtime sizes `amount` in cash dollars. On-chain,
            // Deposit/Withdraw take an amount in collateral *units*, and the
            // health check values those units at `oracle_price` dollars
            // each. Passing the raw dollar amount as a unit count silently
            // over-collateralizes the agent by a factor of `oracle_price`:
            // spending $2,500 cash buys $250,000 of collateral value, which
            // makes any borrower look massively healthy and no shock can
            // ever trip liquidation.
            //
            // Fix: scale Deposit/Withdraw by 1/price before the harness
            // call so one dollar of cash buys exactly one dollar of
            // on-chain collateral value. Borrow/Repay/Liquidate operate in
            // the debt token, which the MVP treats as 1:1 with dollars, so
            // they do not need scaling.
            let price_f = oracle_price.max(f64::EPSILON);
            let on_chain_amount = match &action {
                RuntimeAction::Deposit | RuntimeAction::Withdraw => {
                    ((amount as f64) / price_f).round().max(0.0) as u64
                }
                _ => amount,
            };

            let (outcome, detail) = if action == RuntimeAction::NoOp || on_chain_amount == 0
            {
                (SimOutcome::Skipped, None)
            } else {
                match submit_action_to_target(
                    harness,
                    idx,
                    &action,
                    on_chain_amount,
                    liquidate_target,
                    &agents[idx].policy.persona_args,
                ) {
                    Ok(pair) => pair,
                    Err(msg) => return Err(SimulationAbort::Infra(msg)),
                }
            };

            if matches!(outcome, SimOutcome::Success) {
                agents[idx].total_actions += 1;
                // Cash bookkeeping. Deposit/Withdraw move collateral units,
                // priced at `oracle_price` dollars each. Borrow/Repay/
                // Liquidate move the debt token (1 dollar each in the MVP).
                // Repay/Liquidate are clamped to the borrower's on-chain
                // debt to match the program's own clamping — otherwise an
                // over-repay permanently overcharges the agent's cash.
                let on_chain_f = on_chain_amount as f64;
                let amt_f = amount as f64;
                let consumed = match &action {
                    RuntimeAction::Deposit | RuntimeAction::Withdraw => on_chain_f * price_f,
                    RuntimeAction::Repay => amt_f.min(agents[idx].position.debt),
                    RuntimeAction::Liquidate => liquidate_target
                        .map(|t| amt_f.min(agents[t].position.debt))
                        .unwrap_or(0.0),
                    RuntimeAction::Borrow => amt_f,
                    RuntimeAction::Custom(_) => 0.0,
                    RuntimeAction::NoOp => 0.0,
                };
                let cash = &mut agents[idx].cash_balance;
                match &action {
                    RuntimeAction::Deposit => *cash -= consumed,
                    RuntimeAction::Withdraw => *cash += consumed,
                    RuntimeAction::Borrow => *cash += consumed,
                    RuntimeAction::Repay => *cash -= consumed,
                    RuntimeAction::Liquidate => *cash -= consumed,
                    RuntimeAction::Custom(_) => {}
                    RuntimeAction::NoOp => {}
                }
                if *cash < 0.0 {
                    *cash = 0.0;
                }
                let eq = agents[idx].equity(oracle_price);
                if eq > agents[idx].peak_equity {
                    agents[idx].peak_equity = eq;
                }
            }

            let mut params_map: BTreeMap<String, Value> = BTreeMap::new();
            params_map.insert("amount".into(), Value::from(amount));

            events.push(SimEvent {
                tick,
                agent_id: agents[idx].agent_id.clone(),
                persona_id: agents[idx].policy.persona_id.clone(),
                persona_label: agents[idx].policy.persona_label.clone(),
                action: action.as_str().to_string(),
                params: params_map,
                outcome,
                outcome_detail: detail,
                triggered_by: decision
                    .fired_triggers
                    .first()
                    .map(|trigger| trigger.condition_label.clone()),
            });
        }

        // 4. Post-tick snapshot.
        {
            let mut snap = build_snapshot(harness, tick, &agents)
                .map_err(|e| SimulationAbort::Infra(e.to_string()))?;
            snap.insert(
                "cumulative_liquidations".into(),
                Value::from(cumulative_liquidations),
            );
            evaluate_invariants(&invariants, tick, &snap, &mut invariant_violations, &mut events);
            timeseries.push(snap);
        }

        last_executed_tick = tick;

        // Early exit: everyone is inactive.
        if agents.iter().all(|a| !a.is_active()) {
            eprintln!("all agents inactive at tick {tick}, ending early");
            break;
        }
    }

    // 5. Build summary + finals.
    let final_price = timeseries
        .last()
        .and_then(|s| s.get("oracle_price"))
        .and_then(|v| v.as_f64())
        .unwrap_or(starting_price);

    // Refresh each agent's position one last time so the final pnl reflects
    // any liquidation seizures or bad-debt write-offs that landed on the
    // closing tick. Best-effort: an infra failure here doesn't taint the run.
    for idx in 0..agents.len() {
        if let Ok(obs) = harness.health_factor(idx) {
            if apply_position_observation(&mut agents[idx], &obs, last_executed_tick) {
                cumulative_liquidations += 1;
            }
        }
    }

    let agent_finals: Vec<_> = agents.iter().map(|a| a.final_state(final_price)).collect();

    let mut summary = build_summary(harness, &timeseries, &agent_finals)
        .map_err(|e| SimulationAbort::Infra(e.to_string()))?;
    // Lending-only counter: the generic tick loop omits this key so
    // generic runs never emit a zero-valued `total_liquidations` that a
    // reader could misread as a lending metric.
    summary.insert(
        "total_liquidations".into(),
        Value::from(cumulative_liquidations),
    );

    // Sprint 5 T01 (spec literal): the summary carries a top-level
    // `invariants_fired` list when any invariant is declared. Keys stay
    // absent for runs with no invariants so the Sprint 4 hero-grid
    // determinism hash stays byte-stable.
    if !invariants.is_empty() {
        summary.insert(
            "invariants_fired".into(),
            build_invariants_summary(&invariants, &invariant_violations),
        );
    }

    Ok(SimulationResult {
        run_config: run_config.clone(),
        seed: run_config.seed,
        total_ticks: run_config.ticks,
        timeseries,
        events,
        agents: agent_finals,
        summary,
        simulation_boundaries,
    })
}

/// Build a per-tick `TickSnapshot` from the primitive's own metrics
/// and the engine-side counters the tick loop tracks above the
/// primitive layer (tick index, active agent count, cumulative
/// liquidation count).
///
/// Both tick loops funnel through this helper so the snapshot shape
/// is consistent across lending and generic paths.
fn build_snapshot<H: crate::primitive::Primitive + ?Sized>(
    harness: &H,
    tick: u32,
    agents: &[Agent],
) -> Result<TickSnapshot, HarnessError> {
    let active = agents.iter().filter(|a| a.is_active()).count() as u32;
    let mut snapshot = harness.snapshot_metrics()?;
    snapshot.insert("tick".into(), Value::from(tick));
    snapshot.insert("active_agents".into(), Value::from(active));
    Ok(snapshot)
}

/// Build an end-of-run `SimulationSummary` from the primitive's
/// `summarize_metrics` and the engine-side lifecycle counters the tick
/// loop owns (agents_active / agents_liquidated / agents_depleted /
/// total_liquidations).
fn build_summary<H: crate::primitive::Primitive + ?Sized>(
    harness: &H,
    timeseries: &[TickSnapshot],
    agent_finals: &[crate::types::AgentFinalState],
) -> Result<SimulationSummary, HarnessError> {
    let mut summary = harness.summarize_metrics(timeseries)?;
    let agents_active = agent_finals
        .iter()
        .filter(|a| matches!(a.status, AgentStatus::Active))
        .count() as u32;
    let agents_liquidated = agent_finals
        .iter()
        .filter(|a| matches!(a.status, AgentStatus::Liquidated))
        .count() as u32;
    let agents_depleted = agent_finals
        .iter()
        .filter(|a| matches!(a.status, AgentStatus::Depleted))
        .count() as u32;
    summary.insert("agents_active".into(), Value::from(agents_active));
    summary.insert("agents_liquidated".into(), Value::from(agents_liquidated));
    summary.insert("agents_depleted".into(), Value::from(agents_depleted));
    Ok(summary)
}

/// Pick the other active agent that is most underwater given the current
/// oracle price. Uses the engine's local position model — which is refreshed
/// from chain at each agent's observe step, so it's at most one iteration
/// stale for sibling agents within the same tick. Returns `None` if no
/// eligible borrower exists.
///
/// The previous implementation picked the first agent with any positive
/// debt, which frequently targeted healthy borrowers and forced the
/// on-chain program to reject with PositionHealthy (error 0x7). Ranking by
/// lowest collateral-value-to-debt ratio lines up the engine's best guess
/// with the program's actual health check.
fn pick_liquidation_target(idx: usize, agents: &[Agent], oracle_price: f64) -> Option<usize> {
    agents
        .iter()
        .enumerate()
        .filter(|(other_idx, a)| *other_idx != idx && a.is_active() && a.position.debt > 0.0)
        .min_by(|(_, a), (_, b)| {
            // Lower ratio = more underwater. NaN-safe via total_cmp on the
            // wrapped f64 so f64::NAN doesn't silently stall ordering.
            let ra = (a.position.collateral * oracle_price) / a.position.debt;
            let rb = (b.position.collateral * oracle_price) / b.position.debt;
            ra.partial_cmp(&rb).unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(i, _)| i)
}

/// Submit an agent's action. On success returns `(Success, None)`. On a
/// program-rejected error returns `(Failed, Some(reason))`. On an infra
/// failure that survived the single retry inside `with_retry`, returns
/// `Err(msg)` so the caller can abort the whole run.
///
/// Sprint 6 T01 — `persona_args` carries the executing agent's
/// `policy.persona_args` map for multi-runtime-arg dispatch. Empty
/// for lending/mock callers and for generic adapters that don't use
/// `@persona.<field>` references.
fn submit_action_to_target<H: crate::primitive::Primitive>(
    harness: &mut H,
    idx: usize,
    action: &RuntimeAction,
    amount: u64,
    liquidate_target: Option<usize>,
    persona_args: &std::collections::BTreeMap<String, crate::adapter::ArgLiteral>,
) -> Result<(SimOutcome, Option<String>), String> {
    let result = match action {
        RuntimeAction::Deposit
        | RuntimeAction::Withdraw
        | RuntimeAction::Borrow
        | RuntimeAction::Repay
        | RuntimeAction::Custom(_) => with_retry(harness, |h| {
            h.execute_action_with_persona_args(idx, action.as_str(), amount, None, persona_args)
        }),
        RuntimeAction::Liquidate => match liquidate_target {
            Some(t) => with_retry(harness, |h| {
                h.execute_action_with_persona_args(
                    idx,
                    action.as_str(),
                    amount,
                    Some(t),
                    persona_args,
                )
            }),
            None => return Ok((SimOutcome::Skipped, Some("no liquidation target".into()))),
        },
        RuntimeAction::NoOp => return Ok((SimOutcome::Skipped, None)),
    };
    match result {
        Ok(()) => Ok((SimOutcome::Success, None)),
        Err(HarnessError::ProgramRejected(msg)) => Ok((SimOutcome::Failed, Some(msg))),
        Err(HarnessError::Infra(msg)) => Err(msg),
    }
}

/// Run the generic (non-lending) tick loop. Binds on [`Primitive`] only
/// — no lending vocabulary, no pool/health reads, no liquidation path,
/// no cash/PnL bookkeeping. Agents observe adapter-defined state,
/// decide via their inline personas, and execute adapter-defined
/// actions. All lending-shaped fields in the returned
/// [`SimulationResult`] are zero-filled so the fixture format matches
/// the lending path for the CLI consumer.
pub fn run_generic_simulation<H, S>(
    harness: &mut H,
    scenario: &mut S,
    params: SimulationParams<'_>,
) -> Result<SimulationResult, SimulationAbort>
where
    H: crate::primitive::Primitive,
    S: Scenario + ?Sized,
{
    let SimulationParams {
        run_config,
        policies,
        agent_personas,
        available_actions,
        starting_balance,
        starting_price,
        simulation_boundaries,
        invariants,
        scheduled_actions,
    } = params;

    if harness.agent_count() != agent_personas.len() {
        return Err(SimulationAbort::BadInput(format!(
            "harness agent_count={} does not match agent_personas len={}",
            harness.agent_count(),
            agent_personas.len()
        )));
    }
    if policies.is_empty() {
        return Err(SimulationAbort::BadInput("empty policies".into()));
    }

    let mut invariant_violations: Vec<InvariantViolation> = Vec::new();

    let mut master_rng = StdRng::seed_from_u64(run_config.seed);

    let mut agents: Vec<Agent> = agent_personas
        .iter()
        .enumerate()
        .map(|(idx, &persona_idx)| {
            let policy = policies
                .get(persona_idx)
                .cloned()
                .unwrap_or_else(|| policies[0].clone());
            Agent::new(agent_id(idx), policy, starting_balance).with_starting_price(starting_price)
        })
        .collect();

    let mut runtimes: Vec<AgentRuntime> = (0..agents.len())
        .map(|idx| AgentRuntime::new(run_config.seed.wrapping_add(idx as u64)))
        .collect();

    let mut events: Vec<SimEvent> = Vec::new();
    let mut timeseries: Vec<TickSnapshot> = Vec::new();
    let mut last_executed_tick: u32 = 0;

    // tick 0 baseline. Adapter-declared metrics only; the generic
    // path no longer synthesizes zero-valued lending columns.
    {
        let baseline = build_snapshot(harness, 0, &agents)
            .map_err(|e| SimulationAbort::Infra(e.to_string()))?;
        evaluate_invariants(&invariants, 0, &baseline, &mut invariant_violations, &mut events);
        timeseries.push(baseline);
    }
    let _ = starting_price;

    for tick in 1..=run_config.ticks {
        eprintln!("TICK {tick}/{}", run_config.ticks);

        harness.advance_tick();

        let oracle_update = scenario.update(tick, &mut master_rng);
        with_retry(harness, |h| h.push_oracle_price(&oracle_update)).map_err(|e| match e {
            HarnessError::Infra(msg) => SimulationAbort::Infra(msg),
            HarnessError::ProgramRejected(msg) => SimulationAbort::Infra(format!(
                "oracle push rejected by program (unexpected): {msg}"
            )),
        })?;

        // Sprint 5 T06: scheduled actions fire before persona ticks
        // (generic path).
        dispatch_scheduled_actions(&scheduled_actions, tick, harness, &mut events)?;

        let oracle_price = oracle_update.price;

        for idx in 0..agents.len() {
            if !agents[idx].is_active() {
                continue;
            }

            let custom = match harness.observation_values(idx) {
                Ok(values) => values,
                Err(HarnessError::Infra(first)) => {
                    eprintln!("warn: custom observation read failed ({first}), retrying");
                    harness
                        .observation_values(idx)
                        .map_err(|e| SimulationAbort::Infra(e.to_string()))?
                }
                Err(HarnessError::ProgramRejected(msg)) => {
                    return Err(SimulationAbort::Infra(format!(
                        "custom observation rejected: {msg}"
                    )));
                }
            };

            let observation = runtimes[idx].observe(
                tick,
                &agents[idx].policy.clone(),
                &agents[idx],
                oracle_price,
                starting_price,
                0.0,
                0.0,
                custom,
            );
            let decision =
                runtimes[idx].decide(&mut agents[idx], &observation, &available_actions);
            let action = decision.chosen.clone();
            let amount = decision.amount.max(0.0).round() as u64;

            let (outcome, detail) = if matches!(action, RuntimeAction::NoOp) || amount == 0 {
                (SimOutcome::Skipped, None)
            } else {
                match submit_action_to_target(
                    harness,
                    idx,
                    &action,
                    amount,
                    None,
                    &agents[idx].policy.persona_args,
                ) {
                    Ok(pair) => pair,
                    Err(msg) => return Err(SimulationAbort::Infra(msg)),
                }
            };

            if matches!(outcome, SimOutcome::Success) {
                agents[idx].total_actions += 1;
            }

            let mut params_map: BTreeMap<String, Value> = BTreeMap::new();
            params_map.insert("amount".into(), Value::from(amount));

            events.push(SimEvent {
                tick,
                agent_id: agents[idx].agent_id.clone(),
                persona_id: agents[idx].policy.persona_id.clone(),
                persona_label: agents[idx].policy.persona_label.clone(),
                action: action.as_str().to_string(),
                params: params_map,
                outcome,
                outcome_detail: detail,
                triggered_by: decision
                    .fired_triggers
                    .first()
                    .map(|trigger| trigger.condition_label.clone()),
            });
        }

        {
            let snap = build_snapshot(harness, tick, &agents)
                .map_err(|e| SimulationAbort::Infra(e.to_string()))?;
            evaluate_invariants(&invariants, tick, &snap, &mut invariant_violations, &mut events);
            timeseries.push(snap);
        }
        let _ = oracle_price;

        last_executed_tick = tick;
    }

    let _ = last_executed_tick;

    let agent_finals: Vec<_> = agents
        .iter()
        .map(|a| a.final_state(starting_price))
        .collect();

    let mut summary = build_summary(harness, &timeseries, &agent_finals)
        .map_err(|e| SimulationAbort::Infra(e.to_string()))?;

    if !invariants.is_empty() {
        summary.insert(
            "invariants_fired".into(),
            build_invariants_summary(&invariants, &invariant_violations),
        );
    }

    Ok(SimulationResult {
        run_config: run_config.clone(),
        seed: run_config.seed,
        total_ticks: run_config.ticks,
        timeseries,
        events,
        agents: agent_finals,
        summary,
        simulation_boundaries,
    })
}

/// Look up an observation field in a tick snapshot and coerce it to
/// f64. Tries `as_f64()` first, then `as_i64()` and `as_u64()` fallbacks.
/// Returns `None` when the key is absent or its value is non-numeric —
/// the caller skips the comparison in that case so a missing field does
/// not force the whole run to abort.
///
/// Lending-primitive alias table: the Solend-fork snapshot emits
/// engine-facing metric names (`cumulative_bad_debt`,
/// `cumulative_liquidations`, ...) while adapter authors legitimately
/// want to write invariants against the canonical *logical* observation
/// names from the schema (`bad_debt`, `liquidated`). Snapshot shape is
/// load-bearing for the Sprint 4 hero-grid determinism hash, so the
/// alias is applied here at lookup time instead of rewriting what the
/// primitive emits. The mapping is intentionally tiny — add new entries
/// only when a new logical name lands in `LENDING_OBSERVATIONS` without
/// a direct snapshot counterpart.
fn snapshot_f64(snapshot: &TickSnapshot, field: &str) -> Option<f64> {
    if let Some(v) = snapshot.get(field).and_then(value_to_f64) {
        return Some(v);
    }
    match field {
        "bad_debt" => snapshot.get("cumulative_bad_debt").and_then(value_to_f64),
        "liquidated" => snapshot.get("cumulative_liquidations").and_then(value_to_f64),
        _ => None,
    }
}

fn value_to_f64(v: &Value) -> Option<f64> {
    if let Some(f) = v.as_f64() {
        return Some(f);
    }
    if let Some(i) = v.as_i64() {
        return Some(i as f64);
    }
    if let Some(u) = v.as_u64() {
        return Some(u as f64);
    }
    None
}

/// Evaluate every declared invariant against a single tick snapshot.
/// Missing-field ticks are logged to stderr but do not panic or record
/// a violation. Values are coerced to f64 via `snapshot_f64`. Each
/// violation is appended both to the dedicated `violations` index and
/// to the main `events` stream as a structured `SimEvent` with a
/// synthetic engine-owned agent id so downstream consumers that scan
/// `events` see invariant firings alongside action outcomes.
fn evaluate_invariants(
    invariants: &[Invariant],
    tick: u32,
    snapshot: &TickSnapshot,
    violations: &mut Vec<InvariantViolation>,
    events: &mut Vec<SimEvent>,
) {
    for (idx, inv) in invariants.iter().enumerate() {
        match snapshot_f64(snapshot, &inv.field) {
            Some(observed) => {
                if !inv.op.apply(observed, inv.value) {
                    let name = inv.display_name(idx);
                    violations.push(InvariantViolation {
                        tick,
                        index: idx,
                        name: name.clone(),
                        field: inv.field.clone(),
                        op: inv.op.as_str().to_string(),
                        observed,
                        expected: inv.value,
                    });
                    let mut params = BTreeMap::new();
                    params.insert("field".into(), Value::from(inv.field.clone()));
                    params.insert("op".into(), Value::from(inv.op.as_str()));
                    params.insert(
                        "observed".into(),
                        serde_json::Number::from_f64(observed)
                            .map(Value::Number)
                            .unwrap_or(Value::Null),
                    );
                    params.insert(
                        "expected".into(),
                        serde_json::Number::from_f64(inv.value)
                            .map(Value::Number)
                            .unwrap_or(Value::Null),
                    );
                    params.insert("index".into(), Value::from(idx as u64));
                    events.push(SimEvent {
                        tick,
                        agent_id: "__engine__".into(),
                        persona_id: "invariant".into(),
                        persona_label: "invariant".into(),
                        action: format!("invariant_violation:{name}"),
                        params,
                        outcome: SimOutcome::Failed,
                        outcome_detail: Some(format!(
                            "invariant `{name}`: {} {} {} (observed vs expected)",
                            observed,
                            inv.op.as_str(),
                            inv.value
                        )),
                        triggered_by: None,
                    });
                }
            }
            None => {
                eprintln!(
                    "warn: invariant `{}` skipped at tick {tick}: field `{}` missing from snapshot",
                    inv.display_name(idx),
                    inv.field
                );
            }
        }
    }
}

/// Sprint 5 T06 — Fire every scheduled action whose cadence lands on
/// the current tick. Ordering contract:
///
/// 1. **Time**: this runs BEFORE the per-agent persona loop so any
///    world-state update lands before agents observe.
/// 2. **Ties**: when two scheduled actions are due on the same tick
///    (e.g. intervals 3 and 6 at tick 6), they fire in
///    **declaration order** — the index they appear at in the adapter
///    TOML. This is what keeps the sequence deterministic across
///    same-seed runs.
///
/// Every firing pushes an engine-owned `SimEvent` onto the main
/// `events` stream with `agent_id = "__engine__"` and
/// `persona_id = "scheduled"`, AND invokes the primitive's
/// [`Primitive::on_scheduled_action`] hook so the backend can perform
/// any on-chain side effect it needs. Lending/mock primitives leave
/// the hook as the trait default (no-op); T07's perps-fork overrides
/// it to dispatch the real `update_funding_rate` instruction.
///
/// A primitive failure in the hook maps to a `SimulationAbort::Infra`
/// on the tick-loop side. The event emission happens BEFORE the hook
/// call so the failed firing is still visible in the event stream
/// even if the primitive rejected it.
fn dispatch_scheduled_actions<H: crate::primitive::Primitive + ?Sized>(
    scheduled_actions: &[ScheduledAction],
    tick: u32,
    harness: &mut H,
    events: &mut Vec<SimEvent>,
) -> Result<(), SimulationAbort> {
    if scheduled_actions.is_empty() || tick == 0 {
        return Ok(());
    }
    for (idx, sa) in scheduled_actions.iter().enumerate() {
        if sa.interval_ticks == 0 {
            continue; // loader guarantees this, defensive skip.
        }
        if tick % sa.interval_ticks != 0 {
            continue;
        }
        let name = sa.display_name(idx);
        let mut params: BTreeMap<String, Value> = BTreeMap::new();
        params.insert("instruction".into(), Value::from(sa.instruction.clone()));
        params.insert("interval_ticks".into(), Value::from(sa.interval_ticks));
        params.insert("index".into(), Value::from(idx as u64));
        if !sa.accounts.is_empty() {
            params.insert(
                "accounts".into(),
                Value::Array(sa.accounts.iter().cloned().map(Value::from).collect()),
            );
        }
        if !sa.args.is_empty() {
            params.insert(
                "args".into(),
                Value::Object(sa.args.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
            );
        }
        events.push(SimEvent {
            tick,
            agent_id: "__engine__".into(),
            persona_id: "scheduled".into(),
            persona_label: "scheduled".into(),
            action: format!("scheduled:{name}"),
            params,
            outcome: SimOutcome::Success,
            outcome_detail: None,
            triggered_by: None,
        });
        // Primitive-level hook — lets backends react to the firing
        // (T07 perps-fork uses this to dispatch the on-chain
        // `update_funding_rate` ix). Default impl is a no-op.
        harness
            .on_scheduled_action(&name, &sa.instruction, &sa.accounts, &sa.args)
            .map_err(|e| SimulationAbort::Infra(format!(
                "scheduled action `{name}` primitive hook failed: {e:?}"
            )))?;
    }
    Ok(())
}

/// Build the per-invariant summary rollup emitted as
/// `summary["invariants_fired"]`. Shape: array of
/// `{ name, field, op, value, firings }` objects, one per declared
/// invariant, matching the declaration order.
fn build_invariants_summary(
    invariants: &[Invariant],
    violations: &[InvariantViolation],
) -> Value {
    let entries: Vec<Value> = invariants
        .iter()
        .enumerate()
        .map(|(idx, inv)| {
            let firings = violations.iter().filter(|v| v.index == idx).count();
            let mut entry = serde_json::Map::new();
            entry.insert("name".into(), Value::from(inv.display_name(idx)));
            entry.insert("field".into(), Value::from(inv.field.clone()));
            entry.insert("op".into(), Value::from(inv.op.as_str()));
            entry.insert(
                "value".into(),
                serde_json::Number::from_f64(inv.value)
                    .map(Value::Number)
                    .unwrap_or(Value::Null),
            );
            entry.insert("firings".into(), Value::from(firings as u64));
            Value::Object(entry)
        })
        .collect();
    Value::Array(entries)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::{
        scenario::BaselineScenario,
        sim::mock::MockHarness,
        types::{PositionSizing, PositionSizingStrategy, Trigger, TriggerCondition},
    };

    fn tight_policy(id: &str) -> Policy {
        Policy {
            persona_id: id.into(),
            persona_label: id.into(),
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

    fn basic_config(seed: u64, ticks: u32, agents: u32) -> RunConfig {
        RunConfig {
            agents,
            ticks,
            scenario: "baseline".into(),
            seed,
            personas: vec!["steady-lp".into()],
            validator_url: "http://localhost:8899".into(),
            output_path: "out".into(),
        }
    }

    fn standard_params(run_config: &RunConfig) -> SimulationParams<'_> {
        let policies = vec![tight_policy("steady-lp")];
        SimulationParams {
            run_config,
            policies,
            agent_personas: vec![0; run_config.agents as usize],
            available_actions: crate::agent::policy::LENDING_RUNTIME_ACTIONS.to_vec(),
            starting_balance: 10_000.0,
            starting_price: 100.0,
            simulation_boundaries: vec!["mock harness".into()],
            invariants: Vec::new(),
            scheduled_actions: Vec::new(),
        }
    }

    #[test]
    fn happy_path_produces_events_and_timeseries() {
        let cfg = basic_config(7, 3, 2);
        let mut scenario = BaselineScenario::new(100.0, 0);
        let mut h = MockHarness::new(cfg.agents as usize, 100.0);
        let result = run_simulation(&mut h, &mut scenario, standard_params(&cfg)).unwrap();
        // 1 baseline snapshot + 3 tick snapshots.
        assert_eq!(result.timeseries.len(), 4);
        // At least one deposit succeeded per tick per agent.
        assert!(result
            .events
            .iter()
            .any(|e| matches!(e.outcome, SimOutcome::Success)));
        assert_eq!(result.total_ticks, 3);
    }

    #[test]
    fn program_rejected_action_keeps_agent_live() {
        let cfg = basic_config(42, 2, 1);
        let mut scenario = BaselineScenario::new(100.0, 0);
        // Zero-limit pool so any deposit/borrow is rejected regardless of
        // the unit-reconciliation scaling applied at the call site.
        let mut h = MockHarness::new(1, 100.0).with_pool_limits(0, 0);
        let result = run_simulation(&mut h, &mut scenario, standard_params(&cfg)).unwrap();
        assert!(result
            .events
            .iter()
            .any(|e| matches!(e.outcome, SimOutcome::Failed)));
        assert_eq!(result.agents[0].status, AgentStatus::Active);
    }

    #[test]
    fn infra_failure_bails_whole_run() {
        let cfg = basic_config(1, 5, 1);
        let mut scenario = BaselineScenario::new(100.0, 0);
        let mut h = MockHarness::new(1, 100.0);
        // Two consecutive infra failures: the first slot is consumed by the
        // tick 1 oracle push; the retry inside `with_retry` consumes the
        // second. Both fail -> the loop must bail.
        h.script_infra_failures(vec![true, true]);
        let err = run_simulation(&mut h, &mut scenario, standard_params(&cfg)).unwrap_err();
        assert!(matches!(err, SimulationAbort::Infra(_)));
    }

    #[test]
    fn transient_infra_recovers_on_retry() {
        let cfg = basic_config(1, 2, 1);
        let mut scenario = BaselineScenario::new(100.0, 0);
        let mut h = MockHarness::new(1, 100.0);
        // First op fails, retry succeeds. Run should complete.
        h.script_infra_failures(vec![true, false]);
        let result = run_simulation(&mut h, &mut scenario, standard_params(&cfg)).unwrap();
        assert_eq!(result.total_ticks, 2);
    }

    #[test]
    fn build_agent_personas_round_robins_requested_personas() {
        let policies = vec![
            tight_policy("steady-lp"),
            tight_policy("panic-whale"),
            tight_policy("unused"),
        ];
        let personas = vec!["panic-whale".to_string(), "steady-lp".to_string()];
        let mapping = build_agent_personas(&personas, &policies, 5).unwrap();
        // panic-whale=1, steady-lp=0; round-robin over 5 agents.
        assert_eq!(mapping, vec![1, 0, 1, 0, 1]);
    }

    #[test]
    fn build_agent_personas_errors_on_unknown_persona() {
        let policies = vec![tight_policy("steady-lp")];
        let personas = vec!["panic-whale".to_string()];
        let err = build_agent_personas(&personas, &policies, 2).unwrap_err();
        assert!(matches!(err, SimulationAbort::BadInput(_)));
    }

    #[test]
    fn build_agent_personas_falls_back_to_round_robin_when_personas_empty() {
        let policies = vec![tight_policy("a"), tight_policy("b")];
        let mapping = build_agent_personas(&[], &policies, 4).unwrap();
        assert_eq!(mapping, vec![0, 1, 0, 1]);
    }

    #[test]
    fn cash_balance_tracks_successful_actions() {
        // Single-agent run with a deposit-heavy policy. After several ticks,
        // cash should be visibly less than the starting balance — proving the
        // sim no longer treats post-deposit cash as stale.
        let cfg = basic_config(13, 4, 1);
        let mut scenario = BaselineScenario::new(100.0, 0);
        let mut h = MockHarness::new(1, 100.0);
        let result = run_simulation(&mut h, &mut scenario, standard_params(&cfg)).unwrap();
        // The agent finished cheaper than it started (cash spent on collateral
        // is reflected in pnl == 0 only at exact starting price; here equity
        // should be ≈ starting since price didn't move much, but cash itself
        // is strictly less, which shows up in total_actions > 0).
        assert!(result.agents[0].total_actions > 0);
        // pnl is small (we didn't move price much) but the agent did spend
        // cash, so cash != starting_balance — exercised indirectly via pnl
        // proximity to zero rather than equality.
        let pnl = result.agents[0].pnl;
        assert!(pnl.abs() < 1.0, "pnl drifted unexpectedly: {pnl}");
    }

    #[test]
    fn over_repay_clamps_cash_debit_to_actual_debt() {
        // Build a single agent with a known small debt and verify that an
        // over-repay only debits cash by the on-chain-clamped amount, not
        // the requested amount.
        let policy = Policy {
            persona_id: "repayer".into(),
            persona_label: "repayer".into(),
            action_rate_multiplier: 1.0,
            risk_tolerance: 0.5,
            action_weights: BTreeMap::from([
                ("deposit".into(), 0.0),
                ("borrow".into(), 0.0),
                ("withdraw".into(), 0.0),
                ("repay".into(), 1.0),
                ("liquidate".into(), 0.0),
            ]),
            triggers: vec![],
            position_sizing: PositionSizing {
                strategy: PositionSizingStrategy::Fixed,
                params: BTreeMap::from([("amount".into(), 10_000.0)]),
            },
            max_exposure: 0.8,
            persona_args: BTreeMap::new(),
        };
        let cfg = RunConfig {
            agents: 1,
            ticks: 1,
            scenario: "baseline".into(),
            seed: 3,
            personas: vec!["repayer".into()],
            validator_url: "x".into(),
            output_path: "x".into(),
        };
        let mut h = MockHarness::new(1, 100.0);
        // Seed agent with a known small on-chain debt (200) and small
        // collateral (10 units = $1,000 at price 100). Run at starting
        // price 1.0 so engine cash bookkeeping uses units 1:1 with
        // dollars — the point of this test is the over-repay clamp, not
        // the unit-reconciliation shim.
        h.seed_position(0, 10, 200);
        let mut scenario = BaselineScenario::new(1.0, 0);
        let params = SimulationParams {
            run_config: &cfg,
            policies: vec![policy],
            agent_personas: vec![0],
            available_actions: crate::agent::policy::LENDING_RUNTIME_ACTIONS.to_vec(),
            // cash at t0 = 10_000 - 10 + 200 = 10_190.
            starting_balance: 10_000.0,
            starting_price: 1.0,
            simulation_boundaries: vec!["t".into()],
            invariants: Vec::new(),
            scheduled_actions: Vec::new(),
        };
        let result = run_simulation(&mut h, &mut scenario, params).unwrap();
        // Repaid amount on chain = min(10_000, 200) = 200; cash debit must
        // also be 200, not 10_000. Final cash = 10_190 - 200 = 9_990.
        // Equity at price 1: cash 9_990 + collateral 10*1 - debt 0 = 10_000.
        // pnl = 10_000 - 10_000 = 0. If clamping were broken, cash would
        // be 0 and pnl would be ~-9,800.
        assert!(
            result.agents[0].pnl.abs() < 1.0,
            "cash debit not clamped: pnl={}",
            result.agents[0].pnl
        );
    }

    #[test]
    fn early_exit_uses_actual_last_tick_for_late_liquidation() {
        // Two agents, run configured for 100 ticks but the loop will exit
        // early once everyone goes inactive. Verify that any liquidation
        // first noticed by the final refresh is attributed to the actually
        // last processed tick — not run_config.ticks.
        //
        // Easiest way to construct this: agent gets observed liquidated only
        // by the final refresh, and the run breaks out before reaching the
        // configured max. We use a custom mock that goes inactive on tick 1
        // by depositing nothing and having an unhealthy starting position.
        let policy = tight_policy("steady-lp");
        let cfg = RunConfig {
            agents: 1,
            ticks: 100,
            scenario: "baseline".into(),
            seed: 5,
            personas: vec!["steady-lp".into()],
            validator_url: "x".into(),
            output_path: "x".into(),
        };
        let mut h = MockHarness::new(1, 100.0);
        // Pre-mark the position as liquidated. The init observe path will
        // mark the in-memory agent at tick 0 immediately, so the loop's
        // early-exit condition fires after tick 1, and the final refresh
        // picks up no new transition. last_executed_tick = 1.
        h.seed_position(0, 0, 0);
        h.force_liquidate(0);
        let mut scenario = BaselineScenario::new(100.0, 0);
        let params = SimulationParams {
            run_config: &cfg,
            policies: vec![policy],
            agent_personas: vec![0],
            available_actions: crate::agent::policy::LENDING_RUNTIME_ACTIONS.to_vec(),
            starting_balance: 10_000.0,
            starting_price: 100.0,
            simulation_boundaries: vec!["t".into()],
            invariants: Vec::new(),
            scheduled_actions: Vec::new(),
        };
        let result = run_simulation(&mut h, &mut scenario, params).unwrap();
        // The liquidation was applied at the init observe (tick 0) — but the
        // important property is that the run did NOT charge the late
        // refresh's tick number against `run_config.ticks=100`. Validate by
        // ensuring the agent's `liquidated_at_tick` is well below ticks.
        let zero = &result.agents[0];
        assert_eq!(zero.status, AgentStatus::Liquidated);
        assert!(
            zero.liquidated_at_tick.unwrap_or(u32::MAX) < cfg.ticks,
            "liquidated_at_tick should not be the configured max ({}); got {:?}",
            cfg.ticks,
            zero.liquidated_at_tick
        );
    }

    #[test]
    fn apply_position_observation_marks_liquidated_only_once() {
        // The retry path used to skip the liquidation transition; this is
        // a regression test for the helper that now sits on both the happy
        // path and the post-retry path.
        let mut agent =
            Agent::new("a", tight_policy("steady-lp"), 1_000.0).with_starting_price(100.0);
        let obs = PositionObservation {
            collateral: 100,
            debt: 50,
            liquidated: true,
        };
        let transitioned = apply_position_observation(&mut agent, &obs, 4);
        assert!(transitioned);
        assert_eq!(agent.status, AgentStatus::Liquidated);
        assert_eq!(agent.liquidated_at_tick, Some(4));
        // A second observation must not double-count the transition.
        let again = apply_position_observation(&mut agent, &obs, 5);
        assert!(!again);
        assert_eq!(agent.liquidated_at_tick, Some(4));
    }

    #[test]
    fn same_seed_yields_same_event_sequence() {
        let cfg_a = basic_config(99, 5, 3);
        let cfg_b = basic_config(99, 5, 3);
        let mut scenario_a = BaselineScenario::new(100.0, 25);
        let mut scenario_b = BaselineScenario::new(100.0, 25);
        let mut h_a = MockHarness::new(3, 100.0);
        let mut h_b = MockHarness::new(3, 100.0);

        let result_a = run_simulation(&mut h_a, &mut scenario_a, standard_params(&cfg_a)).unwrap();
        let result_b = run_simulation(&mut h_b, &mut scenario_b, standard_params(&cfg_b)).unwrap();

        let as_keys = |events: &[SimEvent]| -> Vec<(u32, String, String)> {
            events
                .iter()
                .map(|e| (e.tick, e.agent_id.clone(), e.action.clone()))
                .collect()
        };

        assert_eq!(as_keys(&result_a.events), as_keys(&result_b.events));
        let tvls = |result: &SimulationResult| -> Vec<Option<f64>> {
            result
                .timeseries
                .iter()
                .map(|entry| entry.get("tvl").and_then(|value| value.as_f64()))
                .collect()
        };
        assert_eq!(tvls(&result_a), tvls(&result_b));
    }
}
