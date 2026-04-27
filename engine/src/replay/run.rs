use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};

use anyhow::{bail, Result};
use serde_json::Value;

use crate::{
    adapter::{Adapter, ArgLiteral, SemanticSourceBinding, Semantics},
    agent::state::Agent,
    primitive::{LendingPrimitive, Primitive, PrimitiveError},
    replay::{
        oracle_trajectory::{load_oracle_trajectory, OracleTrajectory, OracleTrajectoryTick},
        trajectory::{
            load_initial_state, load_trajectory, ReplayInitialState, ReplayInstruction,
            ReplayMetadata, ReplayTrajectory,
        },
    },
    scenario::OracleUpdate,
    semantics::{
        invariants::{build_expression_invariants_summary, ExpressionInvariantFire},
        roles::{instruction_source_matches, RoleBindingContext},
    },
    sim::run::{
        apply_position_observation, build_invariants_summary, build_summary,
        record_lending_tick_snapshot, record_tick_snapshot, SimulationAbort,
    },
    types::{
        InvariantViolation, Policy, PositionSizing, PositionSizingStrategy, RunConfig, SimEvent,
        SimOutcome, SimulationResult, Trigger,
    },
};

#[derive(Debug, Clone)]
pub struct ReplayBundle {
    pub trajectory_dir: PathBuf,
    pub metadata: ReplayMetadata,
    pub actor_ids: Vec<String>,
    pub total_ticks: u32,
    pub starting_price: f64,
    pub starting_exponent: i8,
    tick_instructions: BTreeMap<u32, Vec<ReplayInstruction>>,
    oracle_updates: BTreeMap<u32, OracleUpdate>,
    pub initial_state: ReplayInitialState,
}

impl ReplayBundle {
    pub fn instructions_for_tick(&self, tick: u32) -> &[ReplayInstruction] {
        self.tick_instructions
            .get(&tick)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    pub fn oracle_update_for_tick(&self, tick: u32) -> Option<&OracleUpdate> {
        self.oracle_updates.get(&tick)
    }
}

/// Load a replay fixture bundle, using the adapter to distinguish
/// replay-reserved `args.target` (pairwise-actor key) from a real IDL
/// arg literally named `target`. Without the adapter reference, any
/// string-valued `args.target` would be inserted into the actor pool —
/// which silently inflates `agent_count` for generic replay actions
/// whose Borsh arg list genuinely contains `target`. See
/// re-review #1 for the failure mode this guards against.
pub fn load_replay_bundle(trajectory_dir: &Path, adapter: &Adapter) -> Result<ReplayBundle> {
    let trajectory_path = trajectory_dir.join("trajectory.json");
    let trajectory = load_trajectory(&trajectory_path)?;

    let oracle_path = trajectory_dir.join("oracle-trajectory.json");
    let oracle = if oracle_path.exists() {
        Some(load_oracle_trajectory(&oracle_path)?)
    } else {
        None
    };

    let initial_state_path = trajectory_dir.join("initial-state.json");
    let initial_state = if initial_state_path.exists() {
        load_initial_state(&initial_state_path)?
    } else {
        ReplayInitialState::default()
    };

    build_bundle(trajectory_dir, adapter, trajectory, oracle, initial_state)
}

fn build_bundle(
    trajectory_dir: &Path,
    adapter: &Adapter,
    trajectory: ReplayTrajectory,
    oracle: Option<OracleTrajectory>,
    initial_state: ReplayInitialState,
) -> Result<ReplayBundle> {
    if trajectory.metadata.name.trim().is_empty() {
        bail!(
            "replay trajectory {}/trajectory.json missing non-empty metadata.name",
            trajectory_dir.display()
        );
    }

    let mut tick_instructions: BTreeMap<u32, Vec<ReplayInstruction>> = BTreeMap::new();
    let mut actor_ids: BTreeSet<String> = BTreeSet::new();
    let mut total_ticks = 0u32;

    for instruction in &initial_state.instructions {
        collect_instruction_actor_ids(instruction, adapter, &mut actor_ids)?;
    }

    for tick in trajectory.ticks {
        total_ticks = total_ticks.max(tick.tick);
        let slot = tick_instructions.entry(tick.tick).or_default();
        for instruction in tick.instructions {
            collect_instruction_actor_ids(&instruction, adapter, &mut actor_ids)?;
            slot.push(instruction);
        }
    }

    let mut oracle_updates = BTreeMap::new();
    let mut starting_price = 100.0;
    let mut starting_exponent = 0i8;
    if let Some(oracle) = oracle {
        let mut first_seen: Option<&OracleTrajectoryTick> = None;
        for point in &oracle.ticks {
            total_ticks = total_ticks.max(point.tick);
            if !point.price.is_finite() || point.price < 0.0 {
                bail!(
                    "oracle trajectory tick {} has invalid price {}",
                    point.tick,
                    point.price
                );
            }
            if let Some(previous) = oracle_updates.insert(
                point.tick,
                OracleUpdate {
                    price: point.price,
                    exponent: point.exponent,
                },
            ) {
                bail!(
                    "oracle trajectory declares duplicate tick {} (existing price={} exponent={})",
                    point.tick,
                    previous.price,
                    previous.exponent
                );
            }
            if first_seen.is_none() {
                first_seen = Some(point);
            }
        }
        if let Some(point) = oracle_updates.get(&0) {
            starting_price = point.price;
            starting_exponent = point.exponent;
        } else if let Some(point) = first_seen {
            starting_price = point.price;
            starting_exponent = point.exponent;
        }
    }

    if actor_ids.is_empty() {
        bail!(
            "replay trajectory {} declares no agents; add at least one instruction with an `agent` field",
            trajectory_dir.display()
        );
    }

    Ok(ReplayBundle {
        trajectory_dir: trajectory_dir.to_path_buf(),
        metadata: trajectory.metadata,
        actor_ids: actor_ids.into_iter().collect(),
        total_ticks,
        starting_price,
        starting_exponent,
        tick_instructions,
        oracle_updates,
        initial_state,
    })
}

fn collect_instruction_actor_ids(
    instruction: &ReplayInstruction,
    adapter: &Adapter,
    actor_ids: &mut BTreeSet<String>,
) -> Result<()> {
    if instruction.name.trim().is_empty() {
        bail!("replay instruction name must be non-empty");
    }
    if instruction.agent.trim().is_empty() {
        bail!(
            "replay instruction `{}` missing non-empty `agent`",
            instruction.name
        );
    }
    actor_ids.insert(instruction.agent.clone());

    // re-review #1 fix: only treat `args.target` as
    // the replay-reserved pairwise-actor key when the adapter does
    // NOT declare `target` as an IDL arg for this action. Otherwise
    // the string is a real Borsh arg value (e.g. a pubkey string)
    // and must NOT be inserted into the actor pool — which would
    // silently inflate `agent_count` and break the replay invariants
    // that cross-check it. Keep symmetric with the check in
    // `dispatch_replay_instruction`.
    let target_is_reserved_actor_key = adapter
        .actions
        .get(instruction.name.as_str())
        .map(|action| !action.takes.iter().any(|arg| arg == "target"))
        .unwrap_or(true);
    if target_is_reserved_actor_key {
        if let Some(ArgLiteral::String(target)) = instruction.args.get("target") {
            if target.trim().is_empty() {
                bail!(
                    "replay instruction `{}` for agent `{}` has an empty args.target",
                    instruction.name,
                    instruction.agent
                );
            }
            actor_ids.insert(target.clone());
        }
    }
    Ok(())
}

pub fn run_replay<H>(
    harness: &mut H,
    adapter: &Adapter,
    bundle: &ReplayBundle,
    output_path: String,
) -> Result<SimulationResult, SimulationAbort>
where
    H: Primitive + ?Sized,
{
    if harness.agent_count() != bundle.actor_ids.len() {
        return Err(SimulationAbort::BadInput(format!(
            "replay harness agent_count={} does not match actor count={} from {}",
            harness.agent_count(),
            bundle.actor_ids.len(),
            bundle.trajectory_dir.display()
        )));
    }

    let actor_index: BTreeMap<String, usize> = bundle
        .actor_ids
        .iter()
        .cloned()
        .enumerate()
        .map(|(idx, actor)| (actor, idx))
        .collect();

    if let Some(update) = bundle.oracle_update_for_tick(0) {
        push_replay_oracle(harness, update)?;
    }
    for instruction in &bundle.initial_state.instructions {
        dispatch_replay_instruction(
            harness,
            adapter,
            instruction,
            u32::MAX,
            &actor_index,
            &mut [],
            None,
        )?;
    }

    let mut agents: Vec<Agent> = bundle
        .actor_ids
        .iter()
        .map(|actor| {
            Agent::new(actor.clone(), synthetic_replay_policy(actor), 0.0)
                .with_starting_price(bundle.starting_price)
        })
        .collect();
    let mut events = Vec::new();
    let mut timeseries = Vec::new();
    let mut invariant_violations: Vec<InvariantViolation> = Vec::new();

    for tick in 0..=bundle.total_ticks {
        if tick > 0 {
            harness.advance_tick();
            if let Some(update) = bundle.oracle_update_for_tick(tick) {
                push_replay_oracle(harness, update)?;
            }
        }

        for instruction in bundle.instructions_for_tick(tick) {
            dispatch_replay_instruction(
                harness,
                adapter,
                instruction,
                tick,
                &actor_index,
                &mut agents,
                Some(&mut events),
            )?;
        }

        record_tick_snapshot(
            harness,
            tick,
            &agents,
            &adapter.invariants,
            &mut invariant_violations,
            &mut events,
            std::iter::empty::<(String, Value)>(),
            &mut timeseries,
        )
        .map_err(|e| SimulationAbort::Infra(e.to_string()))?;
    }

    let final_price = timeseries
        .last()
        .and_then(|snapshot| snapshot.get("oracle_price"))
        .and_then(|value| value.as_f64())
        .unwrap_or(bundle.starting_price);
    let agent_finals: Vec<_> = agents
        .iter()
        .map(|agent| agent.final_state(final_price))
        .collect();

    let mut summary = build_summary(harness, &timeseries, &agent_finals)
        .map_err(|e| SimulationAbort::Infra(e.to_string()))?;
    if !adapter.invariants.is_empty() {
        summary.insert(
            "invariants_fired".into(),
            build_invariants_summary(&adapter.invariants, &invariant_violations),
        );
    }

    Ok(SimulationResult {
        run_config: RunConfig {
            agents: bundle.actor_ids.len() as u32,
            ticks: bundle.total_ticks,
            scenario: format!("replay:{}", bundle.metadata.name),
            seed: 0,
            personas: Vec::new(),
            validator_url: "http://127.0.0.1:8899".into(),
            output_path,
        },
        seed: 0,
        total_ticks: bundle.total_ticks,
        timeseries,
        events,
        agents: agent_finals,
        summary,
        simulation_boundaries: vec![
            "Replay mode bypasses persona compilation and dispatches a declared instruction trajectory directly.".into(),
            "Trajectory args are supplied inline per event; generic adapters may still fall back to adapter literals for unmapped constants.".into(),
            "initial-state.json, when present, is applied as a pre-tick bootstrap instruction list before tick 0 is recorded.".into(),
            "Agent balance/PnL fields are bookkeeping-only in replay mode; authoritative outputs are primitive snapshots, events, and invariant rollups.".into(),
        ],
    })
}

pub fn run_lending_replay<H>(
    harness: &mut H,
    adapter: &Adapter,
    bundle: &ReplayBundle,
    output_path: String,
) -> Result<SimulationResult, SimulationAbort>
where
    H: LendingPrimitive + ?Sized,
{
    if harness.agent_count() != bundle.actor_ids.len() {
        return Err(SimulationAbort::BadInput(format!(
            "replay harness agent_count={} does not match actor count={} from {}",
            harness.agent_count(),
            bundle.actor_ids.len(),
            bundle.trajectory_dir.display()
        )));
    }

    let actor_index: BTreeMap<String, usize> = bundle
        .actor_ids
        .iter()
        .cloned()
        .enumerate()
        .map(|(idx, actor)| (actor, idx))
        .collect();

    if let Some(update) = bundle.oracle_update_for_tick(0) {
        push_replay_oracle(harness, update)?;
    }
    let mut role_binding_anchor: Option<ReplayRoleBindingAnchor> = None;
    for instruction in &bundle.initial_state.instructions {
        dispatch_replay_instruction(
            harness,
            adapter,
            instruction,
            u32::MAX,
            &actor_index,
            &mut [],
            None,
        )?;
        if let Some(anchor) = replay_role_binding_anchor(
            adapter.semantics.as_ref(),
            adapter,
            instruction,
            &actor_index,
        )? {
            role_binding_anchor = Some(anchor);
        }
    }

    let mut agents: Vec<Agent> = bundle
        .actor_ids
        .iter()
        .map(|actor| {
            Agent::new(actor.clone(), synthetic_replay_policy(actor), 0.0)
                .with_starting_price(bundle.starting_price)
        })
        .collect();
    let mut events = Vec::new();
    let mut timeseries = Vec::new();
    let mut invariant_violations: Vec<InvariantViolation> = Vec::new();
    let mut expression_invariant_fires: Vec<ExpressionInvariantFire> = Vec::new();

    for tick in 0..=bundle.total_ticks {
        if tick > 0 {
            harness.advance_tick();
            if let Some(update) = bundle.oracle_update_for_tick(tick) {
                push_replay_oracle(harness, update)?;
            }
        }

        for instruction in bundle.instructions_for_tick(tick) {
            dispatch_replay_instruction(
                harness,
                adapter,
                instruction,
                tick,
                &actor_index,
                &mut agents,
                Some(&mut events),
            )?;
            if let Some(anchor) = replay_role_binding_anchor(
                adapter.semantics.as_ref(),
                adapter,
                instruction,
                &actor_index,
            )? {
                role_binding_anchor = Some(anchor);
            }
        }

        if adapter.semantics.is_some() {
            refresh_lending_replay_agents(harness, &mut agents, tick)?;
        }

        let role_binding_context = role_binding_anchor
            .as_ref()
            .map(ReplayRoleBindingAnchor::as_context)
            .unwrap_or_else(|| RoleBindingContext::tick_snapshot(&agents));
        record_lending_tick_snapshot(
            harness,
            tick,
            &agents,
            &adapter.invariants,
            adapter.semantics.as_ref(),
            role_binding_context,
            &mut invariant_violations,
            &mut expression_invariant_fires,
            &mut events,
            std::iter::empty::<(String, Value)>(),
            &mut timeseries,
        )?;
    }

    let final_price = timeseries
        .last()
        .and_then(|snapshot| snapshot.get("oracle_price"))
        .and_then(|value| value.as_f64())
        .unwrap_or(bundle.starting_price);
    let agent_finals: Vec<_> = agents
        .iter()
        .map(|agent| agent.final_state(final_price))
        .collect();

    let mut summary = build_summary(harness, &timeseries, &agent_finals)
        .map_err(|e| SimulationAbort::Infra(e.to_string()))?;
    if !adapter.invariants.is_empty() {
        summary.insert(
            "invariants_fired".into(),
            build_invariants_summary(&adapter.invariants, &invariant_violations),
        );
    }
    if let Some(semantics) = adapter.semantics.as_ref() {
        summary.insert(
            "expression_invariants".into(),
            build_expression_invariants_summary(&semantics.invariants, &expression_invariant_fires),
        );
    }

    Ok(SimulationResult {
        run_config: RunConfig {
            agents: bundle.actor_ids.len() as u32,
            ticks: bundle.total_ticks,
            scenario: format!("replay:{}", bundle.metadata.name),
            seed: 0,
            personas: Vec::new(),
            validator_url: "http://127.0.0.1:8899".into(),
            output_path,
        },
        seed: 0,
        total_ticks: bundle.total_ticks,
        timeseries,
        events,
        agents: agent_finals,
        summary,
        simulation_boundaries: vec![
            "Replay mode bypasses persona compilation and dispatches a declared instruction trajectory directly.".into(),
            "Trajectory args are supplied inline per event; generic adapters may still fall back to adapter literals for unmapped constants.".into(),
            "initial-state.json, when present, is applied as a pre-tick bootstrap instruction list before tick 0 is recorded.".into(),
            "Agent balance/PnL fields are bookkeeping-only in replay mode; authoritative outputs are primitive snapshots, events, and invariant rollups.".into(),
        ],
    })
}

fn replay_instruction_agent_idx(
    instruction: &ReplayInstruction,
    actor_index: &BTreeMap<String, usize>,
) -> Result<usize, SimulationAbort> {
    actor_index.get(&instruction.agent).copied().ok_or_else(|| {
        SimulationAbort::BadInput(format!(
            "replay instruction `{}` references unknown agent `{}`",
            instruction.name, instruction.agent
        ))
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ReplayRoleBindingAnchor {
    instruction: Option<String>,
    agent_idx: usize,
}

impl ReplayRoleBindingAnchor {
    fn as_context(&self) -> RoleBindingContext<'_> {
        RoleBindingContext::new(self.instruction.as_deref(), Some(self.agent_idx))
    }
}

fn replay_role_binding_anchor(
    semantics: Option<&Semantics>,
    adapter: &Adapter,
    instruction: &ReplayInstruction,
    actor_index: &BTreeMap<String, usize>,
) -> Result<Option<ReplayRoleBindingAnchor>, SimulationAbort> {
    let Some(semantics) = semantics else {
        return Ok(None);
    };
    let Some(position_role) = semantics.roles.get("position") else {
        return Ok(None);
    };
    let Some(binding) = position_role.binding.as_ref() else {
        return Ok(None);
    };
    let anchor = match binding {
        SemanticSourceBinding::Instruction(expected)
            if instruction_source_matches(expected.as_str(), Some(instruction.name.as_str())) =>
        {
            let agent_idx =
                replay_instruction_position_agent_idx(adapter, instruction, actor_index)?;
            Some(ReplayRoleBindingAnchor {
                instruction: Some(instruction.name.clone()),
                agent_idx,
            })
        }
        SemanticSourceBinding::Instruction(_) => None,
        SemanticSourceBinding::Account(path) if is_position_account_path(path) => {
            let agent_idx =
                replay_instruction_position_agent_idx(adapter, instruction, actor_index)?;
            Some(ReplayRoleBindingAnchor {
                instruction: Some(instruction.name.clone()),
                agent_idx,
            })
        }
        SemanticSourceBinding::Account(_) => None,
    };
    Ok(anchor)
}

fn replay_instruction_position_agent_idx(
    adapter: &Adapter,
    instruction: &ReplayInstruction,
    actor_index: &BTreeMap<String, usize>,
) -> Result<usize, SimulationAbort> {
    if replay_target_is_reserved_actor_key(adapter, instruction) {
        if let Some(target) = instruction.args.get("target") {
            return match target {
                ArgLiteral::String(target) => actor_index.get(target).copied().ok_or_else(|| {
                    SimulationAbort::BadInput(format!(
                        "replay instruction `{}` for agent `{}` targets unknown agent `{}`",
                        instruction.name, instruction.agent, target
                    ))
                }),
                other => Err(SimulationAbort::BadInput(format!(
                    "replay instruction `{}` for agent `{}` expected args.target to be a string, got `{other:?}`",
                    instruction.name, instruction.agent
                ))),
            };
        }
    }
    replay_instruction_agent_idx(instruction, actor_index)
}

fn replay_target_is_reserved_actor_key(adapter: &Adapter, instruction: &ReplayInstruction) -> bool {
    adapter
        .actions
        .get(instruction.name.as_str())
        .map(|action| !action.takes.iter().any(|arg| arg == "target"))
        .unwrap_or(true)
}

fn is_position_account_path(path: &str) -> bool {
    matches!(path, "position" | "obligation" | "user_position")
}

fn refresh_lending_replay_agents<H: LendingPrimitive + ?Sized>(
    harness: &H,
    agents: &mut [Agent],
    tick: u32,
) -> Result<(), SimulationAbort> {
    for (idx, agent) in agents.iter_mut().enumerate() {
        let obs = harness
            .health_factor(idx)
            .map_err(|e| SimulationAbort::Infra(e.to_string()))?;
        apply_position_observation(agent, &obs, tick);
    }
    Ok(())
}

fn push_replay_oracle<H: Primitive + ?Sized>(
    harness: &mut H,
    update: &OracleUpdate,
) -> Result<(), SimulationAbort> {
    with_replay_retry(harness, |h| h.push_oracle_price(update)).map_err(|e| match e {
        PrimitiveError::Infra(msg) => SimulationAbort::Infra(msg),
        PrimitiveError::ProgramRejected(msg) => SimulationAbort::Infra(format!(
            "replay oracle update rejected by program (unexpected): {msg}"
        )),
    })
}

fn dispatch_replay_instruction<H: Primitive + ?Sized>(
    harness: &mut H,
    adapter: &Adapter,
    instruction: &ReplayInstruction,
    tick: u32,
    actor_index: &BTreeMap<String, usize>,
    agents: &mut [Agent],
    mut events: Option<&mut Vec<SimEvent>>,
) -> Result<(), SimulationAbort> {
    let agent_idx = actor_index
        .get(&instruction.agent)
        .copied()
        .ok_or_else(|| {
            SimulationAbort::BadInput(format!(
                "replay instruction `{}` references unknown agent `{}`",
                instruction.name, instruction.agent
            ))
        })?;

    // re-review fix: `target` is only the
    // replay-reserved pairwise-actor key when the adapter does NOT
    // declare it as an IDL arg via `[actions.<name>].takes`. Lending
    // adapters leave `adapter.actions` empty by convention, so their
    // `liquidate` action correctly routes through the pairwise path
    // (`target_idx` populated + `target` stripped from args). Generic
    // adapters whose IDL genuinely declares a Borsh arg named `target`
    // (e.g. a `swap(amount_in, target, direction)` shape) now pass
    // `target` through to the encoder unchanged rather than having it
    // silently stripped.
    let target_is_reserved_actor_key = adapter
        .actions
        .get(instruction.name.as_str())
        .map(|action| !action.takes.iter().any(|arg| arg == "target"))
        .unwrap_or(true);

    let target_idx = if target_is_reserved_actor_key {
        match instruction.args.get("target") {
            Some(ArgLiteral::String(target)) => {
                Some(actor_index.get(target).copied().ok_or_else(|| {
                    SimulationAbort::BadInput(format!(
                        "replay instruction `{}` for agent `{}` targets unknown agent `{}`",
                        instruction.name, instruction.agent, target
                    ))
                })?)
            }
            Some(other) => {
                return Err(SimulationAbort::BadInput(format!(
                    "replay instruction `{}` for agent `{}` expected args.target to be a string, got `{other:?}`",
                    instruction.name,
                    instruction.agent
                )));
            }
            None => None,
        }
    } else {
        None
    };

    let replay_args = if target_is_reserved_actor_key {
        instruction
            .args
            .iter()
            .filter(|(key, _)| key.as_str() != "target")
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<BTreeMap<_, _>>()
    } else {
        // Adapter declares `target` as a real IDL arg — pass through
        // to the primitive's encoder unchanged.
        instruction.args.clone()
    };

    let execution = with_replay_retry(harness, |h| {
        h.execute_replay_action(agent_idx, &instruction.name, &replay_args, target_idx)
    });
    let (outcome, detail) = match execution {
        Ok(()) => (SimOutcome::Success, None),
        Err(PrimitiveError::ProgramRejected(msg)) => (SimOutcome::Failed, Some(msg)),
        Err(PrimitiveError::Infra(msg)) => return Err(SimulationAbort::Infra(msg)),
    };

    if matches!(outcome, SimOutcome::Success) {
        if let Some(agent) = agents.get_mut(agent_idx) {
            agent.total_actions += 1;
        }
    }

    if let Some(events) = events.as_deref_mut() {
        events.push(SimEvent {
            tick,
            agent_id: instruction.agent.clone(),
            persona_id: instruction.agent.clone(),
            persona_label: instruction.agent.clone(),
            action: instruction.name.clone(),
            params: replay_args_to_json(&instruction.args),
            outcome,
            outcome_detail: detail,
            triggered_by: None,
        });
    }

    Ok(())
}

fn replay_args_to_json(args: &BTreeMap<String, ArgLiteral>) -> BTreeMap<String, Value> {
    args.iter()
        .map(|(key, value)| {
            let value = match value {
                ArgLiteral::Bool(flag) => Value::Bool(*flag),
                ArgLiteral::Int(number) => Value::from(*number),
                ArgLiteral::String(text) => Value::from(text.clone()),
            };
            (key.clone(), value)
        })
        .collect()
}

fn synthetic_replay_policy(agent: &str) -> Policy {
    Policy {
        persona_id: agent.to_string(),
        persona_label: agent.to_string(),
        action_rate_multiplier: 1.0,
        risk_tolerance: 0.5,
        action_weights: BTreeMap::new(),
        triggers: Vec::<Trigger>::new(),
        position_sizing: PositionSizing {
            strategy: PositionSizingStrategy::Fixed,
            params: BTreeMap::from([("amount".into(), 0.0)]),
        },
        max_exposure: 1.0,
        persona_args: BTreeMap::new(),
    }
}

fn with_replay_retry<H, F>(harness: &mut H, mut op: F) -> Result<(), PrimitiveError>
where
    H: Primitive + ?Sized,
    F: FnMut(&mut H) -> Result<(), PrimitiveError>,
{
    match op(harness) {
        Ok(()) => Ok(()),
        Err(PrimitiveError::ProgramRejected(msg)) => Err(PrimitiveError::ProgramRejected(msg)),
        Err(PrimitiveError::Infra(first)) => {
            eprintln!("warn: replay infra failure, retrying once ({first})");
            op(harness)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::adapter::{
        schema::{ActionDefinition, Adapter, Protocol},
        ArgLiteral,
    };

    fn make_adapter(actions: &[(&str, &[&str])]) -> Adapter {
        let mut adapter = Adapter {
            protocol: Protocol::Generic,
            program_so: None,
            idl_path: None,
            accounts: Default::default(),
            actions: Default::default(),
            observations: Default::default(),
            personas: Default::default(),
            state_mapping: Default::default(),
            instructions: Default::default(),
            oracles: Default::default(),
            scheduled_actions: Default::default(),
            invariants: Default::default(),
            semantics: None,
            lineage: None,
        };
        for (name, takes) in actions {
            adapter.actions.insert(
                (*name).into(),
                ActionDefinition {
                    label: None,
                    takes: takes.iter().map(|s| (*s).into()).collect(),
                },
            );
        }
        adapter
    }

    fn make_instruction(name: &str, agent: &str, target: Option<ArgLiteral>) -> ReplayInstruction {
        let mut args = BTreeMap::new();
        if let Some(value) = target {
            args.insert("target".into(), value);
        }
        ReplayInstruction {
            name: name.into(),
            agent: agent.into(),
            args,
        }
    }

    #[test]
    fn collect_actor_ids_treats_target_as_pairwise_key_by_default() {
        // re-check: when the adapter does NOT
        // declare `target` in `[actions.<name>].takes` (lending
        // shape: adapter.actions is empty by convention), the
        // replay-reserved pairwise-actor interpretation applies
        // and the string target joins the actor pool.
        let adapter = make_adapter(&[]);
        let instruction = make_instruction(
            "liquidate",
            "liquidator-0",
            Some(ArgLiteral::String("whale-0".into())),
        );
        let mut actor_ids = BTreeSet::new();
        collect_instruction_actor_ids(&instruction, &adapter, &mut actor_ids).unwrap();
        assert!(actor_ids.contains("liquidator-0"));
        assert!(
            actor_ids.contains("whale-0"),
            "lending pairwise: args.target is an actor id"
        );
        assert_eq!(actor_ids.len(), 2);
    }

    #[test]
    fn collect_actor_ids_passes_target_through_when_adapter_declares_it() {
        // re-check #1 fix: when the adapter
        // declares `target` as an IDL arg via `takes`, the string
        // is a real Borsh arg value (e.g. a pubkey) and must NOT
        // inflate the actor pool. Previously this path inserted a
        // phantom actor during bundle load even though dispatch
        // later handled `target` correctly.
        let adapter = make_adapter(&[("swap", &["amount_in", "target", "direction"])]);
        let instruction = make_instruction(
            "swap",
            "trader-0",
            Some(ArgLiteral::String(
                "GLe1xiYPUBRQCrxQA1wMVSESmCqY1YgVi1Rrhu7oMUhk".into(),
            )),
        );
        let mut actor_ids = BTreeSet::new();
        collect_instruction_actor_ids(&instruction, &adapter, &mut actor_ids).unwrap();
        assert!(actor_ids.contains("trader-0"));
        assert!(
            !actor_ids.contains("GLe1xiYPUBRQCrxQA1wMVSESmCqY1YgVi1Rrhu7oMUhk"),
            "IDL-declared target must not be inserted into the actor pool"
        );
        assert_eq!(
            actor_ids.len(),
            1,
            "agent_count should stay honest — only the signer agent"
        );
    }

    #[test]
    fn collect_actor_ids_rejects_empty_target_only_for_pairwise() {
        // Empty-string target is still rejected under the pairwise
        // interpretation (same honest-diagnostic as before). Under
        // the IDL-arg interpretation the empty check is irrelevant
        // — the encoder will reject on type-mismatch later.
        let adapter = make_adapter(&[]);
        let instruction = make_instruction(
            "liquidate",
            "liquidator-0",
            Some(ArgLiteral::String(String::new())),
        );
        let mut actor_ids = BTreeSet::new();
        let err =
            collect_instruction_actor_ids(&instruction, &adapter, &mut actor_ids).unwrap_err();
        assert!(err.to_string().contains("empty args.target"));
    }
}
