//! `Harness` trait: the minimal on-chain surface the tick loop touches.

use crate::scenario::OracleUpdate;

/// Pool-wide observation, re-read after every state-changing tx the loop
/// cares about. Units are whatever the on-chain program uses (stable base
/// units for deposits/borrows/bad_debt).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PoolObservation {
    pub total_deposits: u64,
    pub total_borrows: u64,
    pub bad_debt: u64,
}

impl PoolObservation {
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

/// Per-agent position observation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PositionObservation {
    pub collateral: u64,
    pub debt: u64,
    pub liquidated: bool,
}

/// Errors returned by `Harness` methods. The tick loop must treat these
/// two variants very differently:
///
/// * `ProgramRejected` — the program processed the tx and returned an error
///   (CU exceed, HF check, LTV cap, etc.). Log an event, agent stays live,
///   continue the run.
/// * `Infra` — something below the program layer failed (RPC timeout,
///   blockhash expired, validator not reachable, decode error). The loop
///   retries once internally and, if the retry also fails, bails the whole
///   run.
#[derive(Debug, Clone)]
pub enum HarnessError {
    ProgramRejected(String),
    Infra(String),
}

impl std::fmt::Display for HarnessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ProgramRejected(msg) => write!(f, "program rejected: {msg}"),
            Self::Infra(msg) => write!(f, "infra failure: {msg}"),
        }
    }
}

impl std::error::Error for HarnessError {}

/// Abstract on-chain surface the tick loop calls.
///
/// Keep this trait minimal — only what the loop actually exercises. New
/// observability hooks should land here (not on `ValidatorHarness` directly)
/// so the mock can stay in sync.
pub trait Harness {
    /// Number of agents this harness was initialized with.
    fn agent_count(&self) -> usize;

    /// Push a new oracle price on-chain.
    fn push_oracle_price(&mut self, update: &OracleUpdate) -> Result<(), HarnessError>;

    /// Re-read the pool account.
    fn observe_pool(&self) -> Result<PoolObservation, HarnessError>;

    /// Re-read a specific agent's position.
    fn observe_position(&self, agent_idx: usize) -> Result<PositionObservation, HarnessError>;

    /// Advance synthetic chain state between ticks. Backends that
    /// manage their own chain progression (e.g. LiteSVM) override this
    /// to rotate blockhashes, advance slots/clock sysvars, etc. Live
    /// validator backends and mocks default to a no-op.
    fn advance_tick(&mut self) {}

    fn deposit(&mut self, agent_idx: usize, amount: u64) -> Result<(), HarnessError>;
    fn withdraw(&mut self, agent_idx: usize, amount: u64) -> Result<(), HarnessError>;
    fn borrow(&mut self, agent_idx: usize, amount: u64) -> Result<(), HarnessError>;
    fn repay(&mut self, agent_idx: usize, amount: u64) -> Result<(), HarnessError>;
    fn liquidate(
        &mut self,
        liquidator_idx: usize,
        target_idx: usize,
        repay_amount: u64,
    ) -> Result<(), HarnessError>;
}
