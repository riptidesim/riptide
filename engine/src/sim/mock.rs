//! In-memory `Harness` implementation for unit tests.
//!
//! Matches the on-chain lending-pool semantics closely enough that the tick
//! loop's happy path, error-handling, and determinism properties can all be
//! exercised without ever booting a validator.

use std::collections::BTreeMap;

use crate::primitive::{
    dispatch_lending_action, HarnessError, LendingPrimitive, PoolState, PositionHealth, Primitive,
    PrimitiveError,
};
use crate::scenario::OracleUpdate;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MockPosition {
    pub collateral: u64,
    pub debt: u64,
    pub liquidated: bool,
}

#[derive(Debug, Clone)]
pub struct MockHarness {
    /// Oracle price in `1e-exponent` units (mirror of on-chain oracle scaling).
    price_u64: u64,
    price_exponent: i8,
    /// Pool-wide state.
    total_deposits: u64,
    total_borrows: u64,
    bad_debt: u64,
    deposit_limit: u64,
    borrow_limit: u64,
    ltv_bps: u16,
    liquidation_threshold_bps: u16,
    liquidation_bonus_bps: u16,
    /// Per-agent positions.
    positions: Vec<MockPosition>,
    /// Scripted infra failures. Each entry is popped before the next op the
    /// loop performs (oracle push or any agent action). `true` means the
    /// next op returns `Infra`; `false` is a no-op slot. Used by tests to
    /// script specific infra-error sequences.
    scripted_infra_failures: Vec<bool>,
    /// Sprint 5 T06: per-instruction count of scheduled-action hook
    /// invocations the tick loop has driven through this harness.
    /// Tests use this to assert primitive-level side effects beyond the
    /// engine-emitted event stream.
    scheduled_action_calls: BTreeMap<String, u32>,
}

impl MockHarness {
    pub fn new(agent_count: usize, starting_price: f64) -> Self {
        Self {
            price_u64: (starting_price.max(0.0) * 100.0).round() as u64,
            price_exponent: -2,
            total_deposits: 0,
            total_borrows: 0,
            bad_debt: 0,
            // Generous defaults: tests that care about limits set them explicitly.
            deposit_limit: u64::MAX / 2,
            borrow_limit: u64::MAX / 2,
            ltv_bps: 7_000,
            liquidation_threshold_bps: 8_000,
            liquidation_bonus_bps: 500,
            positions: vec![MockPosition::default(); agent_count],
            scripted_infra_failures: Vec::new(),
            scheduled_action_calls: BTreeMap::new(),
        }
    }

    /// Number of times the tick loop fired the named scheduled-action
    /// hook against this harness. Zero if the loop never invoked it
    /// (either because no scheduled actions were declared or because
    /// the cadence hasn't landed on any executed tick yet).
    pub fn scheduled_action_calls(&self, name: &str) -> u32 {
        self.scheduled_action_calls.get(name).copied().unwrap_or(0)
    }

    /// Total number of primitive-level scheduled-action hook
    /// invocations across every declared name. Sum of the per-name
    /// counters.
    pub fn total_scheduled_action_calls(&self) -> u32 {
        self.scheduled_action_calls.values().sum()
    }

    pub fn with_pool_limits(mut self, deposit_limit: u64, borrow_limit: u64) -> Self {
        self.deposit_limit = deposit_limit;
        self.borrow_limit = borrow_limit;
        self
    }

    pub fn with_risk_params(mut self, ltv_bps: u16, liquidation_threshold_bps: u16) -> Self {
        self.ltv_bps = ltv_bps;
        self.liquidation_threshold_bps = liquidation_threshold_bps;
        self
    }

    pub fn with_liquidation_bonus(mut self, bonus_bps: u16) -> Self {
        self.liquidation_bonus_bps = bonus_bps;
        self
    }

    pub fn bad_debt(&self) -> u64 {
        self.bad_debt
    }

    pub fn collateral_of(&self, agent_idx: usize) -> u64 {
        self.positions[agent_idx].collateral
    }

    pub fn force_liquidate(&mut self, agent_idx: usize) {
        self.positions[agent_idx].liquidated = true;
    }

    pub fn seed_position(&mut self, agent_idx: usize, collateral: u64, debt: u64) {
        self.total_deposits = self.total_deposits.saturating_add(collateral);
        self.total_borrows = self.total_borrows.saturating_add(debt);
        self.positions[agent_idx] = MockPosition {
            collateral,
            debt,
            liquidated: false,
        };
    }

    /// Queue infra-failure slots. `true` => next consumed op fails with
    /// `Infra`; `false` => no-op slot (the op runs normally).
    pub fn script_infra_failures(&mut self, slots: Vec<bool>) {
        // Reverse so we can `pop` cheaply and get FIFO semantics.
        self.scripted_infra_failures = slots.into_iter().rev().collect();
    }

    fn maybe_infra_fail(&mut self) -> Result<(), HarnessError> {
        if let Some(fail) = self.scripted_infra_failures.pop() {
            if fail {
                return Err(HarnessError::Infra(
                    "mock: scripted infra failure".to_string(),
                ));
            }
        }
        Ok(())
    }

    /// Match on-chain `max_borrow_value`: collateral * price * ltv_bps / 10_000.
    fn max_borrow_value(&self, collateral: u64) -> u128 {
        let price = self.price_u64 as u128;
        (collateral as u128 * price * self.ltv_bps as u128) / 10_000
    }

    fn liquidation_value(&self, collateral: u64) -> u128 {
        let price = self.price_u64 as u128;
        (collateral as u128 * price * self.liquidation_threshold_bps as u128) / 10_000
    }
}

impl Primitive for MockHarness {
    fn agent_count(&self) -> usize {
        self.positions.len()
    }

    fn push_oracle_price(&mut self, update: &OracleUpdate) -> Result<(), HarnessError> {
        self.maybe_infra_fail()?;
        self.price_u64 = update.as_u64();
        self.price_exponent = update.exponent;
        Ok(())
    }

    fn on_scheduled_action(
        &mut self,
        name: &str,
        _instruction: &str,
        _accounts: &[String],
        _args: &BTreeMap<String, serde_json::Value>,
    ) -> Result<(), PrimitiveError> {
        *self
            .scheduled_action_calls
            .entry(name.to_string())
            .or_insert(0) += 1;
        Ok(())
    }

    fn execute_action(
        &mut self,
        agent_idx: usize,
        action: &str,
        amount: u64,
        target_idx: Option<usize>,
    ) -> Result<(), PrimitiveError> {
        dispatch_lending_action(self, agent_idx, action, amount, target_idx)
    }

    fn snapshot_metrics(
        &self,
    ) -> Result<std::collections::BTreeMap<String, serde_json::Value>, PrimitiveError> {
        use crate::primitive::LendingPrimitive;
        let pool = <Self as LendingPrimitive>::pool_state(self)?;
        let oracle_price = self.current_price_f64();
        let mut metrics = std::collections::BTreeMap::new();
        let number = |value: f64| -> serde_json::Value {
            serde_json::Number::from_f64(value)
                .map(serde_json::Value::Number)
                .unwrap_or(serde_json::Value::Null)
        };
        metrics.insert("tvl".into(), number(pool.total_deposits as f64));
        metrics.insert("utilization".into(), number(pool.utilization()));
        metrics.insert("oracle_price".into(), number(oracle_price));
        metrics.insert("cumulative_bad_debt".into(), number(pool.bad_debt as f64));
        Ok(metrics)
    }

    fn summarize_metrics(
        &self,
        timeseries: &[crate::types::TickSnapshot],
    ) -> Result<std::collections::BTreeMap<String, serde_json::Value>, PrimitiveError> {
        use crate::primitive::LendingPrimitive;
        let pool = <Self as LendingPrimitive>::pool_state(self)?;
        let mut largest: f64 = 0.0;
        for pair in timeseries.windows(2) {
            let prev = pair[0]
                .get("oracle_price")
                .and_then(|value| value.as_f64())
                .unwrap_or(0.0);
            let next = pair[1]
                .get("oracle_price")
                .and_then(|value| value.as_f64())
                .unwrap_or(0.0);
            if prev > 0.0 {
                let drop = ((prev - next) / prev).max(0.0);
                if drop > largest {
                    largest = drop;
                }
            }
        }
        let number = |value: f64| -> serde_json::Value {
            serde_json::Number::from_f64(value)
                .map(serde_json::Value::Number)
                .unwrap_or(serde_json::Value::Null)
        };
        let mut summary = std::collections::BTreeMap::new();
        summary.insert("final_tvl".into(), number(pool.total_deposits as f64));
        summary.insert("final_utilization".into(), number(pool.utilization()));
        summary.insert("total_bad_debt".into(), number(pool.bad_debt as f64));
        summary.insert("largest_single_tick_drawdown".into(), number(largest));
        Ok(summary)
    }
}

impl MockHarness {
    fn current_price_f64(&self) -> f64 {
        let exp = self.price_exponent;
        if exp < 0 {
            (self.price_u64 as f64) / 10f64.powi(i32::from(-exp))
        } else {
            (self.price_u64 as f64) * 10f64.powi(i32::from(exp))
        }
    }
}

impl LendingPrimitive for MockHarness {
    fn pool_state(&self) -> Result<PoolState, PrimitiveError> {
        Ok(PoolState {
            total_deposits: self.total_deposits,
            total_borrows: self.total_borrows,
            bad_debt: self.bad_debt,
        })
    }

    fn health_factor(&self, agent_idx: usize) -> Result<PositionHealth, PrimitiveError> {
        let p = self.positions.get(agent_idx).ok_or_else(|| {
            PrimitiveError::Infra(format!("mock: agent_idx {agent_idx} out of range"))
        })?;
        Ok(PositionHealth {
            collateral: p.collateral,
            debt: p.debt,
            liquidated: p.liquidated,
        })
    }

    fn deposit(&mut self, agent_idx: usize, amount: u64) -> Result<(), HarnessError> {
        self.maybe_infra_fail()?;
        let pos = self
            .positions
            .get_mut(agent_idx)
            .ok_or_else(|| HarnessError::Infra("mock: bad idx".into()))?;
        if pos.liquidated {
            return Err(HarnessError::ProgramRejected("position liquidated".into()));
        }
        let next = self
            .total_deposits
            .checked_add(amount)
            .ok_or_else(|| HarnessError::ProgramRejected("math overflow".into()))?;
        if next > self.deposit_limit {
            return Err(HarnessError::ProgramRejected(
                "deposit limit exceeded".into(),
            ));
        }
        pos.collateral = pos.collateral.saturating_add(amount);
        self.total_deposits = next;
        Ok(())
    }

    fn withdraw(&mut self, agent_idx: usize, amount: u64) -> Result<(), HarnessError> {
        self.maybe_infra_fail()?;
        let pos = self
            .positions
            .get_mut(agent_idx)
            .ok_or_else(|| HarnessError::Infra("mock: bad idx".into()))?;
        if pos.liquidated {
            return Err(HarnessError::ProgramRejected("position liquidated".into()));
        }
        if amount > pos.collateral {
            return Err(HarnessError::ProgramRejected(
                "insufficient collateral".into(),
            ));
        }
        let remaining = pos.collateral - amount;
        if pos.debt > 0 {
            // same HF re-check as the on-chain processor
            let max_debt =
                (remaining as u128) * (self.price_u64 as u128) * (self.ltv_bps as u128) / 10_000;
            if (pos.debt as u128) > max_debt {
                return Err(HarnessError::ProgramRejected(
                    "insufficient collateral".into(),
                ));
            }
        }
        pos.collateral = remaining;
        self.total_deposits = self.total_deposits.saturating_sub(amount);
        Ok(())
    }

    fn borrow(&mut self, agent_idx: usize, amount: u64) -> Result<(), HarnessError> {
        self.maybe_infra_fail()?;
        // Read the read-only bits we need before grabbing a mutable borrow.
        let ltv_cap = {
            let pos = &self.positions[agent_idx];
            self.max_borrow_value(pos.collateral)
        };
        let pos = self
            .positions
            .get_mut(agent_idx)
            .ok_or_else(|| HarnessError::Infra("mock: bad idx".into()))?;
        if pos.liquidated {
            return Err(HarnessError::ProgramRejected("position liquidated".into()));
        }
        let next_total_borrows = self
            .total_borrows
            .checked_add(amount)
            .ok_or_else(|| HarnessError::ProgramRejected("math overflow".into()))?;
        if next_total_borrows > self.borrow_limit {
            return Err(HarnessError::ProgramRejected(
                "borrow limit exceeded".into(),
            ));
        }
        let available = self.total_deposits.saturating_sub(self.total_borrows);
        if amount > available {
            return Err(HarnessError::ProgramRejected(
                "insufficient liquidity".into(),
            ));
        }
        let next_debt = pos
            .debt
            .checked_add(amount)
            .ok_or_else(|| HarnessError::ProgramRejected("math overflow".into()))?;
        if (next_debt as u128) > ltv_cap {
            return Err(HarnessError::ProgramRejected(
                "insufficient collateral".into(),
            ));
        }
        pos.debt = next_debt;
        self.total_borrows = next_total_borrows;
        Ok(())
    }

    fn repay(&mut self, agent_idx: usize, amount: u64) -> Result<(), HarnessError> {
        self.maybe_infra_fail()?;
        let pos = self
            .positions
            .get_mut(agent_idx)
            .ok_or_else(|| HarnessError::Infra("mock: bad idx".into()))?;
        let repaid = amount.min(pos.debt);
        pos.debt -= repaid;
        self.total_borrows = self.total_borrows.saturating_sub(repaid);
        Ok(())
    }

    fn liquidate(
        &mut self,
        liquidator_idx: usize,
        target_idx: usize,
        repay_amount: u64,
    ) -> Result<(), HarnessError> {
        self.maybe_infra_fail()?;
        if liquidator_idx == target_idx {
            return Err(HarnessError::ProgramRejected(
                "cannot liquidate self".into(),
            ));
        }
        let target = self
            .positions
            .get(target_idx)
            .copied()
            .ok_or_else(|| HarnessError::Infra("mock: bad idx".into()))?;
        if target.liquidated {
            return Err(HarnessError::ProgramRejected("position liquidated".into()));
        }
        let liq_value = self.liquidation_value(target.collateral);
        if (target.debt as u128) <= liq_value {
            return Err(HarnessError::ProgramRejected("position healthy".into()));
        }

        let repaid = repay_amount.min(target.debt);
        // Mirror programs/lending_pool/src/processor.rs:303-344 closely:
        // 1. apply liquidation bonus to repaid value;
        // 2. ceil-divide by oracle price to get the collateral units to seize;
        // 3. cap by available collateral; if shortfall, accumulate bad_debt.
        let price = self.price_u64 as u128;
        let seized_value =
            (repaid as u128) * (10_000u128 + self.liquidation_bonus_bps as u128) / 10_000u128;
        let collateral_to_seize = if price == 0 {
            0u64
        } else {
            ((seized_value + price - 1) / price) as u64
        };
        let actual_collateral = collateral_to_seize.min(target.collateral);
        let mut shortfall: u128 = 0;
        if actual_collateral < collateral_to_seize {
            let recovered_value = (actual_collateral as u128) * price;
            shortfall = seized_value.saturating_sub(recovered_value);
        }

        let borrower_now_liquidated;
        {
            let borrower = &mut self.positions[target_idx];
            borrower.debt -= repaid;
            borrower.collateral -= actual_collateral;
            if shortfall > 0 {
                borrower.liquidated = true;
            } else if borrower.debt == 0 {
                borrower.liquidated = true;
            } else {
                let liq_value = (borrower.collateral as u128)
                    * price
                    * (self.liquidation_threshold_bps as u128)
                    / 10_000u128;
                if liq_value < borrower.debt as u128 {
                    borrower.liquidated = true;
                }
            }
            borrower_now_liquidated = borrower.liquidated;
        }
        let _ = borrower_now_liquidated;
        self.total_borrows = self.total_borrows.saturating_sub(repaid);
        self.total_deposits = self.total_deposits.saturating_sub(actual_collateral);
        self.positions[liquidator_idx].collateral = self.positions[liquidator_idx]
            .collateral
            .saturating_add(actual_collateral);
        if shortfall > 0 {
            // Cap at u64; bad_debt mirrors on-chain pool_state.bad_debt.
            let cap = shortfall.min(u64::MAX as u128) as u64;
            self.bad_debt = self.bad_debt.saturating_add(cap);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deposit_and_borrow_update_pool_state() {
        let mut h = MockHarness::new(2, 100.0);
        h.deposit(0, 1_000).unwrap();
        h.borrow(0, 100).unwrap();
        let pool = h.pool_state().unwrap();
        assert_eq!(pool.total_deposits, 1_000);
        assert_eq!(pool.total_borrows, 100);
    }

    #[test]
    fn scripted_infra_failure_is_consumed() {
        let mut h = MockHarness::new(1, 100.0);
        h.script_infra_failures(vec![true]);
        let err = h.deposit(0, 10).unwrap_err();
        assert!(matches!(err, HarnessError::Infra(_)));
        // Second call succeeds — slot has been consumed.
        h.deposit(0, 10).unwrap();
    }

    #[test]
    fn liquidate_applies_bonus_and_books_bad_debt_on_shortfall() {
        // Stage a borrower whose collateral is insufficient to cover the
        // bonused seize value, so the mock must record bad_debt — matching
        // programs/lending_pool/src/processor.rs:325-334.
        let mut h = MockHarness::new(2, 1.0)
            .with_risk_params(7_000, 8_000)
            .with_liquidation_bonus(500);
        // borrower (idx 0): collateral 50, debt 100. Liquidation threshold
        // value = 50 * 100 * 0.8 = 4000 < debt? In raw price_u64=100 units:
        // liq_value = 50 * 100 * 8000 / 10000 = 40_000, debt=100 → healthy.
        // Force unhealthy by giving lots of debt:
        h.seed_position(0, 5, 200);
        // liquidator (idx 1): empty.
        h.seed_position(1, 0, 0);
        // Repay 100 → seized_value = 100 * 10500 / 10000 = 105;
        // collateral_to_seize = ceil(105/100) = 2; available collateral = 5,
        // so no shortfall on this small repay. Try a bigger repay to force
        // shortfall:
        // Repay 200 → seized_value = 210; ceil(210/100)=3; still <=5. Force
        // shortfall by lowering collateral.
        // Re-seed with tiny collateral:
        h.positions[0].collateral = 1;
        h.total_deposits = 1;
        h.liquidate(1, 0, 200).unwrap();
        // shortfall = 210 - (1 * 100) = 110 → bad_debt = 110.
        assert_eq!(h.bad_debt(), 110);
        // Borrower marked liquidated.
        assert!(h.positions[0].liquidated);
        // Liquidator received the actual seized collateral (1 unit).
        assert_eq!(h.collateral_of(1), 1);
    }

    #[test]
    fn borrow_rejected_when_above_ltv_cap() {
        // Constructor stores price as `(price * 100).round()` with exponent=-2,
        // mirroring the on-chain oracle's scaled integer layout. Both the ltv
        // check and the on-chain program multiply the stored `price_u64` by
        // collateral directly, so we set up a case where the ltv cap bites.
        let mut h = MockHarness::new(1, 1.0).with_risk_params(7_000, 8_000);
        h.deposit(0, 1_000).unwrap();
        // max_debt = 1000 * 100 * 7000 / 10000 = 700_000. Ask for more:
        assert!(matches!(
            h.borrow(0, 800_000).unwrap_err(),
            HarnessError::ProgramRejected(_)
        ));
        // A borrow within the ltv cap succeeds.
        h.borrow(0, 500).unwrap();
    }
}
