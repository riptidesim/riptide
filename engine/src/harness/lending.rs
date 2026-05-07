use anyhow::{anyhow, Result};
use borsh::{to_vec, BorshDeserialize, BorshSerialize};
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
};

#[derive(Debug, Clone, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct LendingPoolConfig {
    pub ltv_bps: u16,
    pub liquidation_threshold_bps: u16,
    pub liquidation_bonus_bps: u16,
    pub interest_bps: u16,
    pub deposit_limit: u64,
    pub borrow_limit: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct LendingPoolState {
    pub is_initialized: bool,
    pub admin: [u8; 32],
    pub oracle: [u8; 32],
    pub total_deposits: u64,
    pub total_borrows: u64,
    pub bad_debt: u64,
    pub ltv_bps: u16,
    pub liquidation_threshold_bps: u16,
    pub liquidation_bonus_bps: u16,
    pub interest_bps: u16,
    pub deposit_limit: u64,
    pub borrow_limit: u64,
}

impl LendingPoolState {
    pub fn tvl(&self) -> u64 {
        self.total_deposits
    }

    pub fn utilization(&self) -> f64 {
        if self.total_deposits == 0 {
            0.0
        } else {
            self.total_borrows as f64 / self.total_deposits as f64
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, BorshSerialize, BorshDeserialize, Default)]
pub struct PositionState {
    pub owner: [u8; 32],
    pub collateral: u64,
    pub debt: u64,
    pub liquidated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum LendingInstructionData {
    InitializeOracle { price: u64, exponent: i8 },
    SetOraclePrice { price: u64, exponent: i8 },
    InitializePool { config: LendingPoolConfig },
    Deposit { amount: u64 },
    Withdraw { amount: u64 },
    Borrow { amount: u64 },
    Repay { amount: u64 },
    Liquidate { repay_amount: u64 },
    // Mirror of the program-side variant (programs/lending_pool/src/state.rs).
    // Discriminator 8; existing 0..=7 stay byte-stable.
    Donate { amount: u64 },
}

#[derive(Debug, Clone)]
pub struct LendingProgramClient {
    pub program_id: Pubkey,
}

impl LendingProgramClient {
    pub fn new(program_id: Pubkey) -> Self {
        Self { program_id }
    }

    pub fn initialize_oracle(
        &self,
        admin: Pubkey,
        oracle: Pubkey,
        price: u64,
        exponent: i8,
    ) -> Instruction {
        self.ix(
            vec![
                AccountMeta::new_readonly(admin, true),
                AccountMeta::new(oracle, false),
            ],
            LendingInstructionData::InitializeOracle { price, exponent },
        )
    }

    pub fn set_oracle_price(
        &self,
        admin: Pubkey,
        oracle: Pubkey,
        price: u64,
        exponent: i8,
    ) -> Instruction {
        self.ix(
            vec![
                AccountMeta::new_readonly(admin, true),
                AccountMeta::new(oracle, false),
            ],
            LendingInstructionData::SetOraclePrice { price, exponent },
        )
    }

    pub fn initialize_pool(
        &self,
        admin: Pubkey,
        pool: Pubkey,
        oracle: Pubkey,
        config: LendingPoolConfig,
    ) -> Instruction {
        self.ix(
            vec![
                AccountMeta::new_readonly(admin, true),
                AccountMeta::new(pool, false),
                AccountMeta::new_readonly(oracle, false),
            ],
            LendingInstructionData::InitializePool { config },
        )
    }

    pub fn deposit(
        &self,
        owner: Pubkey,
        pool: Pubkey,
        position: Pubkey,
        amount: u64,
    ) -> Instruction {
        self.ix(
            vec![
                AccountMeta::new_readonly(owner, true),
                AccountMeta::new(pool, false),
                AccountMeta::new(position, false),
            ],
            LendingInstructionData::Deposit { amount },
        )
    }

    /// Build a Withdraw instruction. The on-chain program conditionally
    /// reads the oracle account when `position.debt > 0` to re-check
    /// the health factor after withdrawal. Pass `Some(oracle)` whenever
    /// the position may carry debt; `None` is safe only when debt == 0.
    pub fn withdraw(
        &self,
        owner: Pubkey,
        pool: Pubkey,
        position: Pubkey,
        oracle: Option<Pubkey>,
        amount: u64,
    ) -> Instruction {
        let mut accounts = vec![
            AccountMeta::new_readonly(owner, true),
            AccountMeta::new(pool, false),
            AccountMeta::new(position, false),
        ];
        if let Some(oracle_key) = oracle {
            accounts.push(AccountMeta::new_readonly(oracle_key, false));
        }
        self.ix(accounts, LendingInstructionData::Withdraw { amount })
    }

    pub fn borrow(
        &self,
        owner: Pubkey,
        pool: Pubkey,
        position: Pubkey,
        oracle: Pubkey,
        amount: u64,
    ) -> Instruction {
        self.ix(
            vec![
                AccountMeta::new_readonly(owner, true),
                AccountMeta::new(pool, false),
                AccountMeta::new(position, false),
                AccountMeta::new_readonly(oracle, false),
            ],
            LendingInstructionData::Borrow { amount },
        )
    }

    pub fn repay(&self, owner: Pubkey, pool: Pubkey, position: Pubkey, amount: u64) -> Instruction {
        self.ix(
            vec![
                AccountMeta::new_readonly(owner, true),
                AccountMeta::new(pool, false),
                AccountMeta::new(position, false),
            ],
            LendingInstructionData::Repay { amount },
        )
    }

    /// Build a Donate instruction. The on-chain program removes
    /// `amount` from the donor's collateral without rechecking the
    /// health factor — used by the Euler-shape proof pack to drive an
    /// underwater donor into a liquidator-driven bad-debt cascade.
    pub fn donate(&self, owner: Pubkey, pool: Pubkey, position: Pubkey, amount: u64) -> Instruction {
        self.ix(
            vec![
                AccountMeta::new_readonly(owner, true),
                AccountMeta::new(pool, false),
                AccountMeta::new(position, false),
            ],
            LendingInstructionData::Donate { amount },
        )
    }

    pub fn liquidate(
        &self,
        liquidator: Pubkey,
        pool: Pubkey,
        borrower_position: Pubkey,
        liquidator_position: Pubkey,
        oracle: Pubkey,
        repay_amount: u64,
    ) -> Instruction {
        self.ix(
            vec![
                AccountMeta::new_readonly(liquidator, true),
                AccountMeta::new(pool, false),
                AccountMeta::new(borrower_position, false),
                AccountMeta::new(liquidator_position, false),
                AccountMeta::new_readonly(oracle, false),
            ],
            LendingInstructionData::Liquidate { repay_amount },
        )
    }

    pub fn read_pool_state(&self, data: &[u8]) -> Result<LendingPoolState> {
        LendingPoolState::try_from_slice(data).map_err(|error| anyhow!(error))
    }

    fn ix(&self, accounts: Vec<AccountMeta>, data: LendingInstructionData) -> Instruction {
        Instruction {
            program_id: self.program_id,
            accounts,
            data: to_vec(&data).expect("borsh ix"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reader_returns_metrics() {
        let state = LendingPoolState {
            is_initialized: true,
            admin: [1; 32],
            oracle: [2; 32],
            total_deposits: 1_000,
            total_borrows: 400,
            bad_debt: 10,
            ltv_bps: 6_500,
            liquidation_threshold_bps: 8_000,
            liquidation_bonus_bps: 500,
            interest_bps: 200,
            deposit_limit: 10_000,
            borrow_limit: 5_000,
        };
        let raw = to_vec(&state).unwrap();
        let client = LendingProgramClient::new(Pubkey::new_unique());
        let decoded = client.read_pool_state(&raw).unwrap();

        assert_eq!(decoded.tvl(), 1_000);
        assert!((decoded.utilization() - 0.4).abs() < f64::EPSILON);
    }
}
