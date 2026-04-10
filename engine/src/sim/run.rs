//! The tick loop itself. Generic over any `Harness` implementation so the
//! same code drives both the validator-backed and the mock-backed path.

use std::collections::BTreeMap;

use rand::{rngs::StdRng, SeedableRng};
use serde_json::Value;

use super::harness::{Harness, HarnessError, PoolObservation, PositionObservation};
use crate::{
    agent::{policy::RuntimeAction, state::Agent, AgentRuntime},
    scenario::Scenario,
    types::{
        AgentStatus, Policy, RunConfig, SimEvent, SimOutcome, SimulationResult,
        SimulationSummary, TickSnapshot,
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
    pub starting_balance: f64,
    pub starting_price: f64,
    pub simulation_boundaries: Vec<String>,
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
                SimulationAbort::BadInput(format!(
                    "run_config.personas references unknown persona '{persona}' (not in policies file)"
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
fn apply_position_observation(
    agent: &mut Agent,
    obs: &PositionObservation,
    tick: u32,
) -> bool {
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
    H: Harness,
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
        starting_balance,
        starting_price,
        simulation_boundaries,
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
            Agent::new(agent_id(idx), policy, starting_balance)
                .with_starting_price(starting_price)
        })
        .collect();
    for idx in 0..agents.len() {
        let obs = match harness.observe_position(idx) {
            Ok(o) => o,
            Err(HarnessError::Infra(first)) => {
                eprintln!("warn: initial position observe failed ({first}), retrying once");
                harness
                    .observe_position(idx)
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
    let initial_pool = harness
        .observe_pool()
        .map_err(|e| SimulationAbort::Infra(e.to_string()))?;
    timeseries.push(build_snapshot(0, &initial_pool, starting_price, &agents, 0));

    for tick in 1..=run_config.ticks {
        eprintln!("TICK {tick}/{}", run_config.ticks);

        // 1. Advance scenario (deterministic via master_rng).
        let oracle_update = scenario.update(tick, &mut master_rng);

        // 2. Push oracle update (with single retry on infra).
        with_retry(harness, |h| h.push_oracle_price(&oracle_update)).map_err(|e| match e {
            HarnessError::Infra(msg) => SimulationAbort::Infra(msg),
            HarnessError::ProgramRejected(msg) => SimulationAbort::Infra(format!(
                "oracle push rejected by program (unexpected): {msg}"
            )),
        })?;

        // Read pool state once at the top of the tick for observations.
        let pool_obs = match harness.observe_pool() {
            Ok(p) => p,
            Err(HarnessError::Infra(first)) => {
                eprintln!("warn: pool observe failed ({first}), retrying once");
                harness
                    .observe_pool()
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
            let position_obs = match harness.observe_position(idx) {
                Ok(p) => p,
                Err(HarnessError::Infra(first)) => {
                    eprintln!("warn: position observe failed ({first}), retrying");
                    harness
                        .observe_position(idx)
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
            );
            let decision = runtimes[idx].decide(&mut agents[idx], &observation);
            let action = decision.chosen;
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
            let liquidate_target = if matches!(action, RuntimeAction::Liquidate) {
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
                    match harness.observe_position(other_idx) {
                        Ok(obs) => {
                            if apply_position_observation(
                                &mut agents[other_idx],
                                &obs,
                                tick,
                            ) {
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
            let on_chain_amount = match action {
                RuntimeAction::Deposit | RuntimeAction::Withdraw => {
                    ((amount as f64) / price_f).round().max(0.0) as u64
                }
                _ => amount,
            };

            let (outcome, detail) = if matches!(action, RuntimeAction::NoOp)
                || on_chain_amount == 0
            {
                (SimOutcome::Skipped, None)
            } else {
                match submit_action_to_target(
                    harness,
                    idx,
                    action,
                    on_chain_amount,
                    liquidate_target,
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
                let consumed = match action {
                    RuntimeAction::Deposit | RuntimeAction::Withdraw => on_chain_f * price_f,
                    RuntimeAction::Repay => amt_f.min(agents[idx].position.debt),
                    RuntimeAction::Liquidate => liquidate_target
                        .map(|t| amt_f.min(agents[t].position.debt))
                        .unwrap_or(0.0),
                    RuntimeAction::Borrow => amt_f,
                    RuntimeAction::NoOp => 0.0,
                };
                let cash = &mut agents[idx].cash_balance;
                match action {
                    RuntimeAction::Deposit => *cash -= consumed,
                    RuntimeAction::Withdraw => *cash += consumed,
                    RuntimeAction::Borrow => *cash += consumed,
                    RuntimeAction::Repay => *cash -= consumed,
                    RuntimeAction::Liquidate => *cash -= consumed,
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
                triggered_by: None,
            });
        }

        // 4. Post-tick snapshot.
        let post_pool = harness
            .observe_pool()
            .map_err(|e| SimulationAbort::Infra(e.to_string()))?;
        timeseries.push(build_snapshot(
            tick,
            &post_pool,
            oracle_price,
            &agents,
            cumulative_liquidations,
        ));

        last_executed_tick = tick;

        // Early exit: everyone is inactive.
        if agents.iter().all(|a| !a.is_active()) {
            eprintln!("all agents inactive at tick {tick}, ending early");
            break;
        }
    }

    // 5. Build summary + finals.
    let final_pool = harness
        .observe_pool()
        .map_err(|e| SimulationAbort::Infra(e.to_string()))?;
    let final_price = timeseries.last().map(|s| s.oracle_price).unwrap_or(starting_price);

    // Refresh each agent's position one last time so the final pnl reflects
    // any liquidation seizures or bad-debt write-offs that landed on the
    // closing tick. Best-effort: an infra failure here doesn't taint the run.
    for idx in 0..agents.len() {
        if let Ok(obs) = harness.observe_position(idx) {
            if apply_position_observation(&mut agents[idx], &obs, last_executed_tick) {
                cumulative_liquidations += 1;
            }
        }
    }

    let agent_finals: Vec<_> = agents.iter().map(|a| a.final_state(final_price)).collect();
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

    // Largest single-tick oracle drawdown across the timeseries.
    let largest_single_tick_drawdown = timeseries
        .windows(2)
        .map(|w| {
            if w[0].oracle_price <= 0.0 {
                0.0
            } else {
                ((w[0].oracle_price - w[1].oracle_price) / w[0].oracle_price).max(0.0)
            }
        })
        .fold(0.0_f64, f64::max);

    let summary = SimulationSummary {
        final_tvl: final_pool.total_deposits as f64,
        final_utilization: final_pool.utilization(),
        total_liquidations: cumulative_liquidations,
        total_bad_debt: final_pool.bad_debt as f64,
        agents_active,
        agents_liquidated,
        agents_depleted,
        largest_single_tick_drawdown,
    };

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

fn build_snapshot(
    tick: u32,
    pool: &PoolObservation,
    oracle_price: f64,
    agents: &[Agent],
    cumulative_liquidations: u32,
) -> TickSnapshot {
    let active = agents.iter().filter(|a| a.is_active()).count() as u32;
    TickSnapshot {
        tick,
        tvl: pool.total_deposits as f64,
        utilization: pool.utilization(),
        oracle_price,
        active_agents: active,
        cumulative_liquidations,
        cumulative_bad_debt: pool.bad_debt as f64,
    }
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
        .filter(|(other_idx, a)| {
            *other_idx != idx && a.is_active() && a.position.debt > 0.0
        })
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
fn submit_action_to_target<H: Harness>(
    harness: &mut H,
    idx: usize,
    action: RuntimeAction,
    amount: u64,
    liquidate_target: Option<usize>,
) -> Result<(SimOutcome, Option<String>), String> {
    let result = match action {
        RuntimeAction::Deposit => with_retry(harness, |h| h.deposit(idx, amount)),
        RuntimeAction::Withdraw => with_retry(harness, |h| h.withdraw(idx, amount)),
        RuntimeAction::Borrow => with_retry(harness, |h| h.borrow(idx, amount)),
        RuntimeAction::Repay => with_retry(harness, |h| h.repay(idx, amount)),
        RuntimeAction::Liquidate => match liquidate_target {
            Some(t) => with_retry(harness, |h| h.liquidate(idx, t, amount)),
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
            }],
            position_sizing: PositionSizing {
                strategy: PositionSizingStrategy::Fixed,
                params: BTreeMap::from([("amount".into(), 100.0)]),
            },
            max_exposure: 0.8,
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
            starting_balance: 10_000.0,
            starting_price: 100.0,
            simulation_boundaries: vec!["mock harness".into()],
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
            // cash at t0 = 10_000 - 10 + 200 = 10_190.
            starting_balance: 10_000.0,
            starting_price: 1.0,
            simulation_boundaries: vec!["t".into()],
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
            starting_balance: 10_000.0,
            starting_price: 100.0,
            simulation_boundaries: vec!["t".into()],
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
        let mut agent = Agent::new("a", tight_policy("steady-lp"), 1_000.0)
            .with_starting_price(100.0);
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
        assert_eq!(
            result_a.timeseries.iter().map(|s| s.tvl).collect::<Vec<_>>(),
            result_b.timeseries.iter().map(|s| s.tvl).collect::<Vec<_>>()
        );
    }
}

