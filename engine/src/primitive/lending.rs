//! `LendingPrimitive` — the lending-domain trait.
//!
//! Defines five actions (deposit / borrow / repay / withdraw / liquidate)
//! and two observations (pool state, per-position health factor inputs).
//! Concrete impls live in submodules of `primitive/` — `solend_fork.rs`
//! is the first. T05 will add `generic.rs` for the `GenericPrimitive`
//! impl driven by an adapter TOML.
//!
//! The trait is intentionally thin. It does not carry tick-loop concerns
//! (agent counts, oracle pushes, slot progression) — those live on the
//! `Harness` trait in `sim::harness`. A primitive that wants to drive the
//! tick loop also implements `Harness` and its domain-level methods
//! delegate to the `LendingPrimitive` impl internally.

use crate::sim::harness::{HarnessError, PoolObservation, PositionObservation};

/// Error variants returned by primitive methods. Aliased to `HarnessError`
/// so the tick loop and adapter layer can treat them uniformly without a
/// conversion step.
pub type PrimitiveError = HarnessError;

/// Pool-wide state observation — re-exported from the sim layer so the
/// primitive trait can be read in isolation.
pub type PoolState = PoolObservation;

/// Per-position health observation (collateral, debt, liquidated flag).
/// The actual health-factor number is computed at a higher layer from
/// these fields plus the current oracle price.
pub type PositionHealth = PositionObservation;

/// Abstract lending-protocol surface.
///
/// Five actions the tick loop exercises plus two observations it reads
/// after every state-changing tx.
///
/// Implementations must preserve two invariants:
///
/// 1. **Error classification** — `PrimitiveError::ProgramRejected` means
///    "the program processed the tx and rejected it" (HF violation, LTV
///    cap, etc.). Everything else is `Infra`. The tick loop retries Infra
///    errors once and swallows ProgramRejected into the event log.
/// 2. **Units** — `amount` is in the program's native unit (collateral
///    tokens for deposit/withdraw, debt tokens for borrow/repay/liquidate).
///    The engine is responsible for unit conversions at the boundary.
pub trait LendingPrimitive {
    /// Increase `agent_idx`'s collateral by `amount`.
    fn deposit(&mut self, agent_idx: usize, amount: u64) -> Result<(), PrimitiveError>;

    /// Open or enlarge `agent_idx`'s debt by `amount`. Subject to the
    /// program's health-factor and LTV checks.
    fn borrow(&mut self, agent_idx: usize, amount: u64) -> Result<(), PrimitiveError>;

    /// Reduce `agent_idx`'s debt by up to `amount` (clamped on-chain to
    /// the outstanding debt).
    fn repay(&mut self, agent_idx: usize, amount: u64) -> Result<(), PrimitiveError>;

    /// Reduce `agent_idx`'s collateral by `amount`. If the position has
    /// outstanding debt, the on-chain program re-checks the health
    /// factor and may reject.
    fn withdraw(&mut self, agent_idx: usize, amount: u64) -> Result<(), PrimitiveError>;

    /// Liquidate part of `target_idx`'s debt using `liquidator_idx`'s
    /// cash. Fails with `ProgramRejected` if the target is still healthy.
    fn liquidate(
        &mut self,
        liquidator_idx: usize,
        target_idx: usize,
        repay_amount: u64,
    ) -> Result<(), PrimitiveError>;

    /// Read the pool-wide state (total deposits, borrows, bad debt).
    fn pool_state(&self) -> Result<PoolState, PrimitiveError>;

    /// Read one position's health inputs (collateral, debt, liquidated).
    /// The caller composes these with the current oracle price to derive
    /// the actual health factor.
    fn health_factor(&self, agent_idx: usize) -> Result<PositionHealth, PrimitiveError>;
}
