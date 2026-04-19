//! AMM primitive trait sketch.
//!
//! Compile-only stub. No runnable impl ships with this file. The whole
//! point is to pressure-test the [`Primitive`] base trait: if sketching
//! `AMMPrimitive` alongside `LendingPrimitive` had revealed that the
//! base trait was the wrong shape, the reshape would have happened here
//! and propagated back into the lending side in the same PR.
//!
//! # Pressure-test result
//!
//! No reshape needed. The split already factors the domain-neutral
//! concerns ([`Primitive`]: `agent_count`, `advance_tick`,
//! `push_oracle_price`, `execute_action`, `observation_values`) out of
//! the lending-specific surface ([`LendingPrimitive`]). `AMMPrimitive`
//! slots in as a sibling super-trait of `Primitive` with its own three
//! actions and three observations — no common AMM/lending super-trait
//! is required, no shared observation types need to move, and the two
//! traits do not collide because they define disjoint method sets.
//!
//! If a second-generation AMM impl later needs features beyond this
//! sketch (concentrated liquidity, multi-hop swaps, LP token bookkeeping),
//! extend this trait — do not widen `Primitive`.
//!
//! The `swap` action semantics follow the `execute_action` dispatch
//! convention from [`Primitive`]: the logical action name is `"swap"`,
//! `amount` is the input-token quantity, and `target_idx` is unused
//! (AMMs are agent-vs-pool, not agent-vs-agent). `add_liquidity` and
//! `remove_liquidity` follow the same convention.
//!
//! TODO: impl for a real AMM.

use super::lending::{Primitive, PrimitiveError};

/// Pool-wide AMM reserves. Units are the program's native base units
/// for each side of the pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AmmReserves {
    pub reserve_a: u64,
    pub reserve_b: u64,
}

impl AmmReserves {
    /// Constant-product invariant `k = reserve_a * reserve_b`, returned
    /// as `u128` to avoid overflow on realistic pool sizes.
    pub fn k(&self) -> u128 {
        (self.reserve_a as u128) * (self.reserve_b as u128)
    }

    /// Spot price of token A in units of token B, computed as
    /// `reserve_b / reserve_a`. Returns `0.0` for an empty pool so
    /// callers do not have to branch on the degenerate case.
    pub fn spot_price_a_in_b(&self) -> f64 {
        if self.reserve_a == 0 {
            0.0
        } else {
            self.reserve_b as f64 / self.reserve_a as f64
        }
    }
}

/// AMM-specific primitive surface. Super-trait of [`Primitive`].
///
/// Three actions the AMM tick loop would exercise, three observations
/// it would read. `swap` takes an input side selector via the adapter's
/// `[instructions]` block; the trait itself stays directional-free so
/// the adapter can bind it to any concrete ix on a real AMM program.
///
/// ## Intentionally not in this trait
///
/// - **LP token bookkeeping** — lives inside the impl, not the trait.
/// Adapters expose it via `[state_mapping]` observations if the
/// persona runtime needs to act on LP balances.
/// - **Concentrated-liquidity ticks** — v0 constant-product only.
/// Extend the trait if/when a concrete CLMM impl lands.
/// - **Multi-hop routing** — orchestration concern, lives above the
/// primitive.
///
/// TODO: impl for a real AMM.
#[allow(dead_code)]
pub trait AmmPrimitive: Primitive {
    // --- Actions ---

    /// Swap `amount_in` of one side for the other. Direction is
    /// carried by the adapter's instruction mapping, not the trait.
    fn swap(&mut self, agent_idx: usize, amount_in: u64) -> Result<(), PrimitiveError>;

    /// Deposit `amount_a` + the matching `amount_b` (computed by the
    /// impl from the current reserve ratio) and mint LP tokens to
    /// `agent_idx`.
    fn add_liquidity(
        &mut self,
        agent_idx: usize,
        amount_a: u64,
    ) -> Result<(), PrimitiveError>;

    /// Burn `lp_amount` of `agent_idx`'s LP tokens and return the
    /// proportional share of both reserves.
    fn remove_liquidity(
        &mut self,
        agent_idx: usize,
        lp_amount: u64,
    ) -> Result<(), PrimitiveError>;

    // --- Observations ---

    /// Pool-wide reserves for both sides of the pair.
    fn reserves(&self) -> Result<AmmReserves, PrimitiveError>;

    /// Constant-product invariant `k = reserve_a * reserve_b`.
    /// Default implementation computes from `reserves()` so concrete
    /// impls only have to override it when they track `k` separately
    /// (e.g. after fee accrual in a stableswap curve).
    fn k(&self) -> Result<u128, PrimitiveError> {
        Ok(self.reserves()?.k())
    }

    /// Spot price of token A in units of token B. Default
    /// implementation computes from `reserves()`; concrete impls
    /// override when their pricing curve differs from constant-product.
    fn spot_price(&self) -> Result<f64, PrimitiveError> {
        Ok(self.reserves()?.spot_price_a_in_b())
    }
}
