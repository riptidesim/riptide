//! Re-seat bridge: drive the persona brain and the invariant evaluator against
//! the real-program [`World`].
//!
//! The kernel ([`crate::kernel`]) is pure decision/evaluation logic over an
//! abstract model. This module is the thin glue a guided `flows.rs` uses to
//! (1) build an [`AgentObservation`] from real account reads, (2) turn a chosen
//! [`RuntimeAction`] into a real transaction via an [`ActionExecutor`], and
//! (3) populate an evaluator [`Context`] from on-chain state and fire declared
//! invariants — replacing hand-rolled `ensure!` blocks.

use std::collections::BTreeMap;

use anyhow::{bail, Result};
use solana_sdk::pubkey::Pubkey;

use crate::kernel::persona::{Agent, AgentObservation, AgentRuntime, Decision, RuntimeAction};
use crate::kernel::semantics::{
    evaluate, evaluate_expression_invariants, parse, Context, SemanticsDescriptor, Severity, Value,
};
use crate::kernel::types::ObservationValue;
use crate::world::{TxOutcome, World};

/// Parse and evaluate a single expression source against `context`. Used by
/// generated invariant code to compute `[semantics.derived]` values into the
/// context before the declared invariants run.
pub fn eval_expr(source: &str, context: &Context) -> Result<Value> {
    let expr = parse(source).map_err(|err| anyhow::anyhow!("parse error in `{source}`: {err}"))?;
    evaluate(&expr, context).map_err(|err| anyhow::anyhow!("eval error in `{source}`: {err}"))
}

/// The protocol-open action sink. A chosen [`RuntimeAction`] is executed as a
/// real transaction against the program. Implementors (typically a generated or
/// hand-authored `flows.rs`) build the instruction from generated builders and,
/// for actor-operates-on-target instructions, [`crate::dispatch::ThirdPartyDispatch`].
pub trait ActionExecutor {
    /// The actions personas may choose among this step. The brain always also
    /// considers `NoOp`, so this need not include it.
    fn action_space(&self) -> &[RuntimeAction];

    /// Execute `action` for `actor` with the persona-sized `amount`.
    fn execute(
        &mut self,
        world: &mut World,
        actor: &Pubkey,
        action: &RuntimeAction,
        amount: f64,
    ) -> Result<TxOutcome>;
}

/// Builds an [`AgentObservation`] from arbitrary on-chain reads. The
/// lending-shaped floats are optional (default `0.0`); protocol-open sims drive
/// triggers through `observe(..)` custom observations matched by
/// `TriggerCondition::ObservationCompare`.
#[derive(Debug, Default)]
pub struct ObservationBuilder {
    tick: u32,
    oracle_price: f64,
    utilization: f64,
    price_drop_from_start: f64,
    portfolio_drawdown: f64,
    available_liquidity: f64,
    custom: BTreeMap<String, ObservationValue>,
}

impl ObservationBuilder {
    pub fn new(tick: u32) -> Self {
        Self {
            tick,
            ..Default::default()
        }
    }

    pub fn oracle_price(mut self, price: f64) -> Self {
        self.oracle_price = price;
        self
    }

    pub fn utilization(mut self, utilization: f64) -> Self {
        self.utilization = utilization;
        self
    }

    pub fn price_drop_from_start(mut self, drop: f64) -> Self {
        self.price_drop_from_start = drop;
        self
    }

    pub fn portfolio_drawdown(mut self, drawdown: f64) -> Self {
        self.portfolio_drawdown = drawdown;
        self
    }

    pub fn available_liquidity(mut self, liquidity: f64) -> Self {
        self.available_liquidity = liquidity;
        self
    }

    /// Record a custom observation a `TriggerCondition::ObservationCompare`
    /// trigger can match against.
    pub fn observe(mut self, key: impl Into<String>, value: ObservationValue) -> Self {
        self.custom.insert(key.into(), value);
        self
    }

    pub fn build(self) -> AgentObservation {
        let mut observation = AgentObservation::new(
            self.tick,
            self.oracle_price,
            self.utilization,
            self.price_drop_from_start,
            self.portfolio_drawdown,
            self.available_liquidity,
        );
        observation.custom_observations = self.custom;
        observation
    }
}

/// Builds an evaluator [`Context`] from on-chain state (the same offset reads a
/// hand-rolled invariant block does today), to feed
/// [`run_expression_invariants`].
#[derive(Debug, Default)]
pub struct ContextBuilder {
    context: Context,
}

impl ContextBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn u128(mut self, key: impl Into<String>, value: u128) -> Self {
        self.context.insert(key.into(), Value::U128(value));
        self
    }

    pub fn i128(mut self, key: impl Into<String>, value: i128) -> Self {
        self.context.insert(key.into(), Value::I128(value));
        self
    }

    pub fn bool(mut self, key: impl Into<String>, value: bool) -> Self {
        self.context.insert(key.into(), Value::Bool(value));
        self
    }

    pub fn build(self) -> Context {
        self.context
    }
}

/// Evaluate the declared invariants against `context`, record every fire on the
/// world (string markers, as `record_invariant_fire` expects), and fail the
/// iteration on the first `Error`-severity fire. `Warn` fires are recorded but
/// do not stop the run, so they land on the risk surface as a gradient.
pub fn run_expression_invariants(
    world: &mut World,
    descriptor: &SemanticsDescriptor,
    context: &Context,
    tick: u32,
) -> Result<()> {
    let fires = evaluate_expression_invariants(descriptor, context, tick)
        .map_err(|err| anyhow::anyhow!("invariant evaluation failed at tick {tick}: {err}"))?;
    for fire in &fires {
        world.record_invariant_fire(&fire.name);
    }
    if let Some(fatal) = fires.iter().find(|fire| fire.severity == Severity::Error) {
        bail!(
            "invariant `{}` violated at tick {}",
            fatal.name,
            fatal.tick
        );
    }
    Ok(())
}

/// One persona step over `agents`: observe → `decide(available_actions)` →
/// execute. `actors[i]` is the on-chain signer for `agents[i]`. A `NoOp`
/// decision executes nothing. Returns each agent's decision so the caller can
/// record metrics. The persona brain stays pure — account construction lives in
/// the caller's [`ActionExecutor`].
pub fn step_personas(
    world: &mut World,
    runtime: &mut AgentRuntime,
    agents: &mut [Agent],
    actors: &[Pubkey],
    observe: impl Fn(&mut World, &Agent) -> AgentObservation,
    executor: &mut dyn ActionExecutor,
) -> Result<Vec<Decision>> {
    if actors.len() != agents.len() {
        bail!(
            "step_personas: {} actors for {} agents",
            actors.len(),
            agents.len()
        );
    }
    // Fresh blockhash per step so a persona repeating the same fixed-size action
    // across flows does not dedup to `AlreadyProcessed` in LiteSVM.
    world.expire_blockhash();
    let action_space = executor.action_space().to_vec();
    let mut decisions = Vec::with_capacity(agents.len());
    for (idx, agent) in agents.iter_mut().enumerate() {
        let observation = observe(world, agent);
        let decision = runtime.decide(agent, &observation, &action_space);
        if !matches!(decision.chosen, RuntimeAction::NoOp) {
            executor.execute(world, &actors[idx], &decision.chosen, decision.amount)?;
            agent.total_actions += 1;
        }
        decisions.push(decision);
    }
    Ok(decisions)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::semantics::Severity;
    use crate::kernel::types::{Policy, PositionSizing, PositionSizingStrategy};

    fn policy(action: &str) -> Policy {
        Policy {
            persona_id: "test".into(),
            persona_label: "Test".into(),
            action_rate_multiplier: 1.0,
            risk_tolerance: 0.5,
            action_weights: BTreeMap::from([(action.to_string(), 1.0)]),
            triggers: Vec::new(),
            position_sizing: PositionSizing {
                strategy: PositionSizingStrategy::Fixed,
                params: BTreeMap::from([("amount".into(), 10.0)]),
            },
            max_exposure: 1.0,
            persona_args: BTreeMap::new(),
        }
    }

    #[derive(Default)]
    struct CountingExecutor {
        space: Vec<RuntimeAction>,
        executed: Vec<(String, f64)>,
    }

    impl ActionExecutor for CountingExecutor {
        fn action_space(&self) -> &[RuntimeAction] {
            &self.space
        }

        fn execute(
            &mut self,
            _world: &mut World,
            _actor: &Pubkey,
            action: &RuntimeAction,
            amount: f64,
        ) -> Result<TxOutcome> {
            self.executed.push((action.as_str().to_string(), amount));
            Ok(TxOutcome {
                label: Some(action.as_str().to_string()),
                ok: true,
                expected_error: false,
                signature: String::new(),
                error: None,
                logs: Vec::new(),
                compute_units_consumed: 0,
            })
        }
    }

    #[test]
    fn step_personas_executes_the_chosen_protocol_action() {
        let mut world = World::new(Pubkey::new_unique());
        let mut runtime = AgentRuntime::new(7);
        let mut agents = vec![Agent::new("a", policy("open_swap"), 1_000.0)];
        let actors = vec![Pubkey::new_unique()];
        let mut executor = CountingExecutor {
            space: vec![RuntimeAction::Custom("open_swap".into())],
            executed: Vec::new(),
        };

        let decisions = step_personas(
            &mut world,
            &mut runtime,
            &mut agents,
            &actors,
            |_world, _agent| ObservationBuilder::new(1).build(),
            &mut executor,
        )
        .unwrap();

        assert_eq!(decisions.len(), 1);
        assert_eq!(decisions[0].chosen, RuntimeAction::Custom("open_swap".into()));
        assert_eq!(executor.executed, vec![("open_swap".to_string(), 10.0)]);
        assert_eq!(agents[0].total_actions, 1);
    }

    #[test]
    fn run_expression_invariants_records_warn_and_fails_on_error() {
        let mut world = World::new(Pubkey::new_unique());

        // Warn fire: recorded, does not fail.
        let mut warn = SemanticsDescriptor::new();
        warn.invariant("soft", "x >= 1", Severity::Warn).unwrap();
        let ctx = ContextBuilder::new().u128("x", 0).build();
        run_expression_invariants(&mut world, &warn, &ctx, 3).unwrap();
        assert_eq!(world.iteration_invariant_fires(), &["soft".to_string()]);

        // Error fire: recorded and fails the iteration.
        let mut hard = SemanticsDescriptor::new();
        hard.invariant("hard", "y >= 1", Severity::Error).unwrap();
        let ctx = ContextBuilder::new().u128("y", 0).build();
        let err = run_expression_invariants(&mut world, &hard, &ctx, 4).unwrap_err();
        assert!(err.to_string().contains("invariant `hard` violated"));
        assert!(world
            .iteration_invariant_fires()
            .contains(&"hard".to_string()));
    }
}
