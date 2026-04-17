//! Primitive traits — the two-tier split the tick loop dispatches through.
//!
//! An earlier `LendingPrimitive` trait conflated two different
//! contracts. It carried the five lending actions
//! (deposit/borrow/repay/withdraw/liquidate) and the two lending
//! observations (`pool_state`, `health_factor`) alongside
//! domain-neutral sim-layer concerns (`agent_count`, `advance_tick`,
//! `push_oracle_price`, `execute_action`, `observation_values`). A
//! generic non-lending impl (`GenericHarness`) was forced to impl the
//! full trait and stub the lending-specific methods as
//! `ProgramRejected` / zero, which the tick loop then silently
//! consumed — a technical-debt smell flagged in review.
//!
//! The split:
//!
//! - [`Primitive`] is the domain-neutral base trait every backend
//!   implements. It exposes only the hooks the generic tick loop
//!   needs: agent count, tick advance, oracle push, action dispatch,
//!   and adapter-defined observation reads.
//! - [`LendingPrimitive`] is a super-trait of `Primitive` that adds
//!   the lending-specific actions and observations. The lending tick
//!   loop binds on this trait.
//!
//! ```text
//!        ┌───────────────────────┐
//!        │   sim::run::*         │
//!        ├───────────────────────┤
//!        │  run_simulation       │ generic over H: LendingPrimitive
//!        │  run_generic_sim      │ generic over H: Primitive
//!        └──────────┬────────────┘
//!                   │
//!        ┌──────────▼────────────┐
//!        │       Primitive       │   agent_count / advance_tick /
//!        │   (base trait)        │   push_oracle_price /
//!        │                       │   execute_action / observation_values
//!        └──────────┬────────────┘
//!                   │ super-trait
//!        ┌──────────▼────────────┐
//!        │   LendingPrimitive    │   deposit / borrow / repay /
//!        │                       │   withdraw / liquidate /
//!        │                       │   pool_state / health_factor
//!        └───────────────────────┘
//! ```
//!
//! `Harness` is a re-export of `LendingPrimitive` so the legacy
//! `use sim::harness::Harness` imports keep resolving for the lending
//! path.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::{
    scenario::OracleUpdate,
    types::{ObservationValue, TickSnapshot},
};

/// Pool-wide observation. Units follow whatever the on-chain program
/// uses — stable base units for deposits/borrows/bad_debt in the
/// Solend fork.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PoolState {
    pub total_deposits: u64,
    pub total_borrows: u64,
    pub bad_debt: u64,
}

impl PoolState {
    pub fn utilization(&self) -> f64 {
        if self.total_deposits == 0 {
            0.0
        } else {
            self.total_borrows as f64 / self.total_deposits as f64
        }
    }

    pub fn available_liquidity(&self) -> u64 {
        self.total_deposits.saturating_sub(self.total_borrows)
    }
}

/// Per-agent health-factor inputs. Collateral / debt / liquidated-flag.
/// The actual health-factor number is computed at a higher layer from
/// these fields plus the current oracle price.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PositionHealth {
    pub collateral: u64,
    pub debt: u64,
    pub liquidated: bool,
}

/// Errors returned by `LendingPrimitive` methods. The tick loop must
/// treat the two variants very differently:
///
/// * `ProgramRejected` — the program processed the tx and returned an
///   error (HF violation, LTV cap, over-repay, etc.). Log an event,
///   the agent stays live, continue the run.
/// * `Infra` — something below the program layer failed (decode error,
///   account-not-found, blockhash miss, sanitization). The tick loop
///   retries once and bails the whole run if the retry also fails.
#[derive(Debug, Clone)]
pub enum PrimitiveError {
    ProgramRejected(String),
    Infra(String),
}

impl std::fmt::Display for PrimitiveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ProgramRejected(msg) => write!(f, "program rejected: {msg}"),
            Self::Infra(msg) => write!(f, "infra failure: {msg}"),
        }
    }
}

impl std::error::Error for PrimitiveError {}

/// Domain-neutral primitive surface.
///
/// Every backend the engine can drive — lending fork, generic
/// adapter-driven program, mock — implements this trait. It carries
/// only the methods the sim layer genuinely needs without knowing the
/// protocol domain:
///
/// - `agent_count` for input validation,
/// - `advance_tick` for synthetic chain progression,
/// - `push_oracle_price` for scenario-driven price updates (backends
///   that don't consume prices default to a no-op),
/// - `execute_action` for dispatching an adapter-level action name,
/// - `observation_values` for reading adapter-defined observations
///   back into the agent runtime.
///
/// Lending-specific action and observation methods live on the
/// [`LendingPrimitive`] super-trait below.
///
/// ## Invariants
///
/// 1. **Error classification** — `PrimitiveError::ProgramRejected`
///    means "the program processed the tx and rejected it";
///    `Infra` means the failure was below the program layer.
/// 2. **Determinism** — implementations must be deterministic under
///    a fixed seed and fixed action sequence.
pub trait Primitive {
    /// Number of agents this primitive was initialized with.
    fn agent_count(&self) -> usize;

    /// Advance synthetic chain state between ticks. LiteSVM backends
    /// override this to rotate blockhashes and advance slot/clock
    /// sysvars. Mock/legacy backends default to a no-op.
    fn advance_tick(&mut self) {}

    /// Push a new oracle price into the program's pricing feed.
    /// Backends without a price feed default to a no-op.
    fn push_oracle_price(
        &mut self,
        _update: &OracleUpdate,
    ) -> Result<(), PrimitiveError> {
        Ok(())
    }

    /// Sprint 5 T06: invoked by the tick loop when a declared
    /// scheduled action fires. `instruction` is the adapter's
    /// `[[scheduled_actions]][…].instruction` value and `name` is the
    /// action's display name. Default impl is a no-op so lending and
    /// generic primitives continue to work without any scheduled
    /// actions declared. T07's perps-fork primitive overrides this
    /// to dispatch the on-chain instruction directly.
    ///
    /// Implementations are observed by
    /// `sim::run::dispatch_scheduled_actions` AFTER the engine-owned
    /// `SimEvent` is emitted, so a primitive-level failure is
    /// reported through the caller's tick-loop error path while the
    /// event stream still records the attempted firing.
    fn on_scheduled_action(
        &mut self,
        _name: &str,
        _instruction: &str,
        _accounts: &[String],
        _args: &BTreeMap<String, Value>,
    ) -> Result<(), PrimitiveError> {
        Ok(())
    }

    /// Execute an adapter-level action for `agent_idx`. `action` is
    /// the logical action name (e.g. "deposit", "mine");
    /// `target_idx` is only populated for lending-style pairwise
    /// actions like `liquidate`.
    fn execute_action(
        &mut self,
        agent_idx: usize,
        action: &str,
        amount: u64,
        target_idx: Option<usize>,
    ) -> Result<(), PrimitiveError>;

    /// Sprint 6 T01 — multi-runtime-arg dispatch.
    ///
    /// Called by the tick loop with the executing agent's
    /// `policy.persona_args` map. Generic primitives override this
    /// to feed the map into `GenericInstructionBuilder::build_action_data`
    /// so multi-arg Borsh instructions can resolve `@persona.<field>`
    /// references at dispatch time.
    ///
    /// Default implementation ignores `persona_args` and dispatches
    /// through the single-arg `execute_action`. Lending primitives
    /// and the test `MockHarness` inherit this default — they neither
    /// use multi-arg Borsh dispatch nor carry persona-supplied arg
    /// maps, so the Sprint 4/5 byte-identical behavior is preserved.
    fn execute_action_with_persona_args(
        &mut self,
        agent_idx: usize,
        action: &str,
        amount: u64,
        target_idx: Option<usize>,
        persona_args: &std::collections::BTreeMap<String, crate::adapter::ArgLiteral>,
    ) -> Result<(), PrimitiveError> {
        let _ = persona_args;
        self.execute_action(agent_idx, action, amount, target_idx)
    }

    /// Read adapter-defined observations for `agent_idx`. Lending
    /// impls keep the default empty map; generic impls return the
    /// decoded state of every account bound in the adapter's
    /// `[state_mapping]` block.
    fn observation_values(
        &self,
        _agent_idx: usize,
    ) -> Result<BTreeMap<String, ObservationValue>, PrimitiveError> {
        Ok(BTreeMap::new())
    }

    /// Per-tick metric snapshot in this primitive's own schema.
    ///
    /// Every primitive contributes its own per-tick metric keys to the
    /// rollup. The tick loop overlays engine-side
    /// counters (tick, active_agents, cumulative_liquidations) on top.
    /// Default: empty map — backends that have nothing to report stay
    /// silent instead of faking zero-valued lending keys.
    fn snapshot_metrics(&self) -> Result<BTreeMap<String, Value>, PrimitiveError> {
        Ok(BTreeMap::new())
    }

    /// End-of-run summary in this primitive's own schema.
    ///
    /// The tick loop passes the already-built `timeseries` so
    /// derived-cross-tick stats (largest drawdown, observation
    /// avg/min/max) can be computed without re-reading state. The
    /// tick loop overlays engine-side lifecycle counters
    /// (agents_active/liquidated/depleted, total_liquidations) on top.
    fn summarize_metrics(
        &self,
        _timeseries: &[TickSnapshot],
    ) -> Result<BTreeMap<String, Value>, PrimitiveError> {
        Ok(BTreeMap::new())
    }
}

/// Lending-specific primitive surface. Super-trait of `Primitive`.
///
/// Five actions the lending tick loop exercises, two observations it
/// reads after every state-changing tx. The lending tick loop binds
/// on this trait so it can call `pool_state`, `health_factor`, and
/// the canonical five actions directly.
///
/// A default `execute_action` dispatches the five canonical action
/// names through the typed methods, which means lending impls get
/// [`Primitive`]'s `execute_action` satisfied automatically via this
/// default, without touching the trait body explicitly.
///
/// ## Units
///
/// `amount` is in the program's native unit (collateral tokens for
/// deposit/withdraw, debt tokens for borrow/repay/liquidate). The
/// engine is responsible for unit conversions at the boundary.
pub trait LendingPrimitive: Primitive {
    // --- Actions ---

    /// Increase `agent_idx`'s collateral by `amount`.
    fn deposit(&mut self, agent_idx: usize, amount: u64) -> Result<(), PrimitiveError>;

    /// Open or enlarge `agent_idx`'s debt by `amount`. Subject to the
    /// program's health-factor and LTV checks.
    fn borrow(&mut self, agent_idx: usize, amount: u64) -> Result<(), PrimitiveError>;

    /// Reduce `agent_idx`'s debt by up to `amount` (clamped on-chain
    /// to the outstanding debt).
    fn repay(&mut self, agent_idx: usize, amount: u64) -> Result<(), PrimitiveError>;

    /// Reduce `agent_idx`'s collateral by `amount`. If the position
    /// has outstanding debt, the on-chain program re-checks the
    /// health factor and may reject.
    fn withdraw(&mut self, agent_idx: usize, amount: u64) -> Result<(), PrimitiveError>;

    /// Liquidate part of `target_idx`'s debt using `liquidator_idx`'s
    /// cash. Fails with `ProgramRejected` if the target is still healthy.
    fn liquidate(
        &mut self,
        liquidator_idx: usize,
        target_idx: usize,
        repay_amount: u64,
    ) -> Result<(), PrimitiveError>;

    // --- Observations ---

    /// Read the pool-wide state (total deposits, borrows, bad debt).
    fn pool_state(&self) -> Result<PoolState, PrimitiveError>;

    /// Read one position's health inputs (collateral, debt,
    /// liquidated). The caller composes these with the current
    /// oracle price to derive the actual health factor.
    fn health_factor(&self, agent_idx: usize) -> Result<PositionHealth, PrimitiveError>;

    // --- legacy name-compat aliases ---
    //
    // Earlier code (including `tests/t06_litesvm_parity.rs`) called the
    // observations `observe_pool` / `observe_position`. The canonical
    // names are `pool_state` / `health_factor`; the default-method shims
    // below preserve the old call sites so the parity test suite does
    // not need to change.

    /// Back-compat alias for `pool_state`. Prefer `pool_state` in new code.
    fn observe_pool(&self) -> Result<PoolState, PrimitiveError> {
        self.pool_state()
    }

    /// Back-compat alias for `health_factor`. Prefer `health_factor` in new code.
    fn observe_position(
        &self,
        agent_idx: usize,
    ) -> Result<PositionHealth, PrimitiveError> {
        self.health_factor(agent_idx)
    }
}

/// Default action-dispatch helper for lending backends.
///
/// A concrete lending impl wires `Primitive::execute_action` to this
/// helper in one line so it doesn't have to re-enumerate the five
/// canonical lending actions. This keeps the dispatch logic in one
/// place while still leaving `Primitive::execute_action` as a required
/// method (so generic impls cannot accidentally inherit a lending
/// fallback).
pub fn dispatch_lending_action<H: LendingPrimitive + ?Sized>(
    harness: &mut H,
    agent_idx: usize,
    action: &str,
    amount: u64,
    target_idx: Option<usize>,
) -> Result<(), PrimitiveError> {
    match action {
        "deposit" => harness.deposit(agent_idx, amount),
        "withdraw" => harness.withdraw(agent_idx, amount),
        "borrow" => harness.borrow(agent_idx, amount),
        "repay" => harness.repay(agent_idx, amount),
        "liquidate" => {
            let target_idx = target_idx.ok_or_else(|| {
                PrimitiveError::ProgramRejected(
                    "liquidate action missing target_idx".to_string(),
                )
            })?;
            harness.liquidate(agent_idx, target_idx, amount)
        }
        other => Err(PrimitiveError::ProgramRejected(format!(
            "unknown lending action `{other}`"
        ))),
    }
}

// ---------------------------------------------------------------------------
// Legacy type aliases
// ---------------------------------------------------------------------------
//
// Legacy imports of `HarnessError`, `PoolObservation`,
// `PositionObservation` from `sim::harness` resolve to the
// `primitive::lending` types via re-export — one canonical type, two
// paths.

pub type HarnessError = PrimitiveError;
pub type PoolObservation = PoolState;
pub type PositionObservation = PositionHealth;

// ---------------------------------------------------------------------------
// `Harness` — same trait as `LendingPrimitive`, different name
// ---------------------------------------------------------------------------

/// `Harness` is an alias for `LendingPrimitive`. Legacy callers that
/// imported `use sim::harness::Harness;` keep working; callers that
/// import `use primitive::LendingPrimitive;` also keep working — they
/// are literally the same trait. No method-resolution ambiguity
/// because there is only one trait defining `deposit`, `borrow`, etc.
pub use LendingPrimitive as Harness;
