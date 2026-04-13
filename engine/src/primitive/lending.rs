//! `LendingPrimitive` — the lending-domain trait the tick loop executes.
//!
//! Defines the five lending actions (deposit / borrow / repay / withdraw /
//! liquidate) and the two observations (`pool_state`, `health_factor`).
//! Concrete impls live in submodules of `primitive/` — `solend_fork.rs`
//! is the first. T05 will add `generic.rs` for the `GenericPrimitive`
//! impl driven by an adapter TOML.
//!
//! ## The trait the tick loop calls
//!
//! The Sprint 3 T03 rearchitecture makes **this trait** the one the
//! tick loop dispatches through. Sprint 2 shipped a `Harness` trait in
//! `sim::harness` with all the lending-action methods on it; that
//! trait is now a re-export of `LendingPrimitive` (`pub use ... as
//! Harness`), which means:
//!
//! 1. `use sim::harness::Harness;` and `use primitive::LendingPrimitive;`
//!    bring the **same trait** into scope — no method-call ambiguity.
//! 2. Deleting `LendingPrimitive` or changing any method body inside an
//!    `impl LendingPrimitive for <T>` immediately changes the tick
//!    loop's behavior, because there is no parallel `Harness`
//!    implementation to hide behind.
//! 3. `sim::run` and tests that only import `Harness` keep compiling
//!    without modification, because `Harness` *is* `LendingPrimitive`.
//!
//! Sim-layer concerns that aren't lending-specific — `agent_count`,
//! `push_oracle_price`, `advance_tick` — live on this trait too. They
//! have default implementations on trait objects where it makes sense
//! (`advance_tick` defaults to a no-op); a primitive that needs to
//! override them can do so in its own impl block.

use crate::scenario::OracleUpdate;

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

/// Abstract lending-protocol surface.
///
/// Five actions the tick loop exercises, two observations it reads
/// after every state-changing tx, plus three sim-layer concerns
/// (`agent_count`, `push_oracle_price`, `advance_tick`) that a
/// lending backend needs to drive a full simulation run. All of them
/// live on the same trait so:
///
/// - method-call resolution is unambiguous (`h.deposit(...)` resolves
///   to exactly one method),
/// - the tick loop binds to **one** trait (`H: LendingPrimitive`),
/// - there is no parallel "Harness has deposit too" dispatch path
///   that could decay back into a decorative primitive.
///
/// `sim::harness::Harness` is a re-export of this trait — same trait,
/// two names, zero duplication.
///
/// ## Invariants
///
/// 1. **Error classification** — `PrimitiveError::ProgramRejected`
///    means "the program processed the tx and rejected it";
///    `Infra` means the failure was below the program layer.
/// 2. **Units** — `amount` is in the program's native unit (collateral
///    tokens for deposit/withdraw, debt tokens for
///    borrow/repay/liquidate). The engine is responsible for unit
///    conversions at the boundary.
pub trait LendingPrimitive {
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

    // --- Sim-layer concerns ---

    /// Number of agents this primitive was initialized with. The tick
    /// loop uses this to validate the input `agent_personas` vector
    /// has a matching length.
    fn agent_count(&self) -> usize;

    /// Push a new oracle price into the program's pricing feed. In
    /// the lending context this updates the value used by subsequent
    /// health-factor checks.
    fn push_oracle_price(&mut self, update: &OracleUpdate) -> Result<(), PrimitiveError>;

    /// Advance synthetic chain state between ticks. Backends that
    /// manage their own chain progression (LiteSVM) override this to
    /// rotate blockhashes, advance slots/clock sysvars, etc.
    /// Mock/legacy backends default to a no-op.
    fn advance_tick(&mut self) {}

    // --- Sprint 2 name-compat aliases ---
    //
    // Sprint 2 code (including `tests/t06_litesvm_parity.rs`) called
    // the observations `observe_pool` / `observe_position`. The
    // Sprint 3 T03 spec renames them to `pool_state` / `health_factor`.
    // The default-method shims below preserve the old call sites so
    // the parity test suite does not need to change (the T03
    // constraints explicitly forbid modifying it).

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

// ---------------------------------------------------------------------------
// Sprint 2 type aliases
// ---------------------------------------------------------------------------
//
// Sprint 2 imports `HarnessError`, `PoolObservation`, `PositionObservation`
// from `sim::harness`. These names now resolve to the `primitive::lending`
// types via re-export — one canonical type, two paths.

pub type HarnessError = PrimitiveError;
pub type PoolObservation = PoolState;
pub type PositionObservation = PositionHealth;

// ---------------------------------------------------------------------------
// `Harness` — same trait as `LendingPrimitive`, different name
// ---------------------------------------------------------------------------

/// `Harness` is an alias for `LendingPrimitive`. Sprint 2 callers that
/// imported `use sim::harness::Harness;` keep working; Sprint 3 callers
/// that import `use primitive::LendingPrimitive;` also keep working —
/// they are literally the same trait. No method-resolution ambiguity
/// because there is only one trait defining `deposit`, `borrow`, etc.
pub use LendingPrimitive as Harness;
