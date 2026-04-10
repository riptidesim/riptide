use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    program_error::ProgramError,
    pubkey::Pubkey,
};

use crate::{
    error::LendingError,
    state::{
        collateral_value, health_factor_bps, liquidation_value, max_borrow_value,
        LendingInstructionData, LendingPoolState, OracleState, PositionState, ORACLE_STATE_LEN,
        POOL_STATE_LEN, POSITION_STATE_LEN, BPS_DENOMINATOR,
    },
};

pub struct Processor;

impl Processor {
    pub fn process(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        instruction_data: &[u8],
    ) -> Result<(), ProgramError> {
        let instruction = LendingInstructionData::try_from_slice(instruction_data)
            .map_err(|_| ProgramError::InvalidInstructionData)?;
        let accounts_iter = &mut accounts.iter();

        match instruction {
            LendingInstructionData::InitializeOracle { price, exponent } => {
                let admin = next_account_info(accounts_iter)?;
                let oracle = next_account_info(accounts_iter)?;
                Self::require_signer(admin)?;
                Self::assert_program_account(oracle, program_id, ORACLE_STATE_LEN)?;

                Self::write_state(
                    oracle,
                    &OracleState {
                        is_initialized: true,
                        admin: admin.key.to_bytes(),
                        price,
                        exponent,
                        reserved: [0; 8],
                    },
                )
            }
            LendingInstructionData::SetOraclePrice { price, exponent } => {
                let admin = next_account_info(accounts_iter)?;
                let oracle = next_account_info(accounts_iter)?;
                Self::require_signer(admin)?;
                Self::assert_program_account(oracle, program_id, ORACLE_STATE_LEN)?;

                let mut oracle_state: OracleState = Self::read_state(oracle)?;
                if !oracle_state.is_initialized {
                    return Err(LendingError::UninitializedOracle.into());
                }
                if oracle_state.admin_pubkey() != *admin.key {
                    return Err(LendingError::Unauthorized.into());
                }

                oracle_state.price = price;
                oracle_state.exponent = exponent;
                Self::write_state(oracle, &oracle_state)
            }
            LendingInstructionData::InitializePool { config } => {
                let admin = next_account_info(accounts_iter)?;
                let pool = next_account_info(accounts_iter)?;
                let oracle = next_account_info(accounts_iter)?;
                Self::require_signer(admin)?;
                Self::assert_program_account(pool, program_id, POOL_STATE_LEN)?;
                Self::assert_program_account(oracle, program_id, ORACLE_STATE_LEN)?;

                let oracle_state: OracleState = Self::read_state(oracle)?;
                if !oracle_state.is_initialized {
                    return Err(LendingError::UninitializedOracle.into());
                }

                Self::write_state(
                    pool,
                    &LendingPoolState {
                        is_initialized: true,
                        admin: admin.key.to_bytes(),
                        oracle: oracle.key.to_bytes(),
                        total_deposits: 0,
                        total_borrows: 0,
                        bad_debt: 0,
                        ltv_bps: config.ltv_bps,
                        liquidation_threshold_bps: config.liquidation_threshold_bps,
                        liquidation_bonus_bps: config.liquidation_bonus_bps,
                        interest_bps: config.interest_bps,
                        deposit_limit: config.deposit_limit,
                        borrow_limit: config.borrow_limit,
                    },
                )
            }
            LendingInstructionData::Deposit { amount } => {
                let owner = next_account_info(accounts_iter)?;
                let pool = next_account_info(accounts_iter)?;
                let position = next_account_info(accounts_iter)?;
                Self::require_signer(owner)?;
                Self::assert_program_account(pool, program_id, POOL_STATE_LEN)?;
                Self::assert_program_account(position, program_id, POSITION_STATE_LEN)?;

                let mut pool_state: LendingPoolState = Self::read_initialized_pool(pool)?;
                let mut position_state: PositionState = Self::read_state(position)?;

                if position_state.is_uninitialized() {
                    position_state.owner = owner.key.to_bytes();
                }
                if position_state.owner_pubkey() != *owner.key {
                    return Err(LendingError::Unauthorized.into());
                }
                if position_state.liquidated {
                    return Err(LendingError::PositionLiquidated.into());
                }
                if pool_state
                    .total_deposits
                    .checked_add(amount)
                    .ok_or(LendingError::MathOverflow)?
                    > pool_state.deposit_limit
                {
                    return Err(LendingError::DepositLimitExceeded.into());
                }

                pool_state.total_deposits = pool_state
                    .total_deposits
                    .checked_add(amount)
                    .ok_or(LendingError::MathOverflow)?;
                position_state.collateral = position_state
                    .collateral
                    .checked_add(amount)
                    .ok_or(LendingError::MathOverflow)?;

                Self::write_state(pool, &pool_state)?;
                Self::write_state(position, &position_state)
            }
            LendingInstructionData::Withdraw { amount } => {
                let owner = next_account_info(accounts_iter)?;
                let pool = next_account_info(accounts_iter)?;
                let position = next_account_info(accounts_iter)?;
                Self::require_signer(owner)?;
                Self::assert_program_account(pool, program_id, POOL_STATE_LEN)?;
                Self::assert_program_account(position, program_id, POSITION_STATE_LEN)?;

                let mut pool_state: LendingPoolState = Self::read_initialized_pool(pool)?;
                let mut position_state: PositionState = Self::read_state(position)?;

                if position_state.owner_pubkey() != *owner.key {
                    return Err(LendingError::Unauthorized.into());
                }
                if position_state.liquidated {
                    return Err(LendingError::PositionLiquidated.into());
                }
                if amount > position_state.collateral {
                    return Err(LendingError::InsufficientCollateral.into());
                }

                let remaining_collateral = position_state
                    .collateral
                    .checked_sub(amount)
                    .ok_or(LendingError::MathOverflow)?;

                if position_state.debt > 0 {
                    let oracle = next_account_info(accounts_iter)
                        .map_err(|_| LendingError::MissingOracleAccount)?;
                    let oracle_state = Self::load_pool_oracle(program_id, &pool_state, oracle)?;
                    let max_debt =
                        max_borrow_value(remaining_collateral, pool_state.ltv_bps, &oracle_state)?;
                    if (position_state.debt as u128) > max_debt {
                        return Err(LendingError::InsufficientCollateral.into());
                    }
                }

                position_state.collateral = remaining_collateral;
                pool_state.total_deposits = pool_state
                    .total_deposits
                    .checked_sub(amount)
                    .ok_or(LendingError::MathOverflow)?;

                Self::write_state(pool, &pool_state)?;
                Self::write_state(position, &position_state)
            }
            LendingInstructionData::Borrow { amount } => {
                let owner = next_account_info(accounts_iter)?;
                let pool = next_account_info(accounts_iter)?;
                let position = next_account_info(accounts_iter)?;
                let oracle = next_account_info(accounts_iter)?;
                Self::require_signer(owner)?;
                Self::assert_program_account(pool, program_id, POOL_STATE_LEN)?;
                Self::assert_program_account(position, program_id, POSITION_STATE_LEN)?;

                let mut pool_state: LendingPoolState = Self::read_initialized_pool(pool)?;
                let mut position_state: PositionState = Self::read_state(position)?;
                let oracle_state = Self::load_pool_oracle(program_id, &pool_state, oracle)?;

                if position_state.owner_pubkey() != *owner.key {
                    return Err(LendingError::Unauthorized.into());
                }
                if position_state.liquidated {
                    return Err(LendingError::PositionLiquidated.into());
                }
                if pool_state
                    .total_borrows
                    .checked_add(amount)
                    .ok_or(LendingError::MathOverflow)?
                    > pool_state.borrow_limit
                {
                    return Err(LendingError::BorrowLimitExceeded.into());
                }

                let available_liquidity = collateral_value(pool_state.total_deposits, &oracle_state)?
                    .checked_sub(pool_state.total_borrows as u128)
                    .ok_or(LendingError::MathOverflow)?;
                if (amount as u128) > available_liquidity {
                    return Err(LendingError::InsufficientLiquidity.into());
                }

                let next_debt = position_state
                    .debt
                    .checked_add(amount)
                    .ok_or(LendingError::MathOverflow)?;
                let max_debt = max_borrow_value(position_state.collateral, pool_state.ltv_bps, &oracle_state)?;
                if (next_debt as u128) > max_debt {
                    return Err(LendingError::InsufficientCollateral.into());
                }

                position_state.debt = next_debt;
                pool_state.total_borrows = pool_state
                    .total_borrows
                    .checked_add(amount)
                    .ok_or(LendingError::MathOverflow)?;

                Self::write_state(pool, &pool_state)?;
                Self::write_state(position, &position_state)
            }
            LendingInstructionData::Repay { amount } => {
                let owner = next_account_info(accounts_iter)?;
                let pool = next_account_info(accounts_iter)?;
                let position = next_account_info(accounts_iter)?;
                Self::require_signer(owner)?;
                Self::assert_program_account(pool, program_id, POOL_STATE_LEN)?;
                Self::assert_program_account(position, program_id, POSITION_STATE_LEN)?;

                let mut pool_state: LendingPoolState = Self::read_initialized_pool(pool)?;
                let mut position_state: PositionState = Self::read_state(position)?;

                if position_state.owner_pubkey() != *owner.key {
                    return Err(LendingError::Unauthorized.into());
                }

                let repaid = amount.min(position_state.debt);
                position_state.debt = position_state
                    .debt
                    .checked_sub(repaid)
                    .ok_or(LendingError::MathOverflow)?;
                pool_state.total_borrows = pool_state
                    .total_borrows
                    .checked_sub(repaid)
                    .ok_or(LendingError::MathOverflow)?;

                Self::write_state(pool, &pool_state)?;
                Self::write_state(position, &position_state)
            }
            LendingInstructionData::Liquidate { repay_amount } => {
                let liquidator = next_account_info(accounts_iter)?;
                let pool = next_account_info(accounts_iter)?;
                let borrower_position = next_account_info(accounts_iter)?;
                let liquidator_position = next_account_info(accounts_iter)?;
                let oracle = next_account_info(accounts_iter)?;
                Self::require_signer(liquidator)?;
                Self::assert_program_account(pool, program_id, POOL_STATE_LEN)?;
                Self::assert_program_account(borrower_position, program_id, POSITION_STATE_LEN)?;
                Self::assert_program_account(liquidator_position, program_id, POSITION_STATE_LEN)?;

                let mut pool_state: LendingPoolState = Self::read_initialized_pool(pool)?;
                let mut borrower: PositionState = Self::read_state(borrower_position)?;
                let mut liquidator_state: PositionState = Self::read_state(liquidator_position)?;
                let oracle_state = Self::load_pool_oracle(program_id, &pool_state, oracle)?;

                if liquidator_state.is_uninitialized() {
                    liquidator_state.owner = liquidator.key.to_bytes();
                }
                if liquidator_state.owner_pubkey() != *liquidator.key {
                    return Err(LendingError::Unauthorized.into());
                }
                if borrower.liquidated {
                    return Err(LendingError::PositionLiquidated.into());
                }
                if health_factor_bps(&borrower, &pool_state, &oracle_state)? >= BPS_DENOMINATOR {
                    return Err(LendingError::PositionHealthy.into());
                }

                let repaid = repay_amount.min(borrower.debt);
                borrower.debt = borrower
                    .debt
                    .checked_sub(repaid)
                    .ok_or(LendingError::MathOverflow)?;
                pool_state.total_borrows = pool_state
                    .total_borrows
                    .checked_sub(repaid)
                    .ok_or(LendingError::MathOverflow)?;

                let seized_value = (repaid as u128)
                    .checked_mul(BPS_DENOMINATOR + pool_state.liquidation_bonus_bps as u128)
                    .ok_or(LendingError::MathOverflow)?
                    .checked_div(BPS_DENOMINATOR)
                    .ok_or(LendingError::MathOverflow)?;
                let oracle_price = oracle_state.price_multiplier()?;
                let collateral_to_seize = seized_value
                    .checked_add(oracle_price - 1)
                    .ok_or(LendingError::MathOverflow)?
                    .checked_div(oracle_price)
                    .ok_or(LendingError::MathOverflow)? as u64;

                let actual_collateral = collateral_to_seize.min(borrower.collateral);
                borrower.collateral = borrower
                    .collateral
                    .checked_sub(actual_collateral)
                    .ok_or(LendingError::MathOverflow)?;
                liquidator_state.collateral = liquidator_state
                    .collateral
                    .checked_add(actual_collateral)
                    .ok_or(LendingError::MathOverflow)?;

                if actual_collateral < collateral_to_seize {
                    let recovered_value = (actual_collateral as u128)
                        .checked_mul(oracle_price)
                        .ok_or(LendingError::MathOverflow)?;
                    let shortfall = seized_value.saturating_sub(recovered_value);
                    pool_state.bad_debt = pool_state
                        .bad_debt
                        .checked_add(shortfall.min(u64::MAX as u128) as u64)
                        .ok_or(LendingError::MathOverflow)?;
                    borrower.liquidated = true;
                } else if borrower.debt == 0 {
                    borrower.liquidated = true;
                } else if liquidation_value(
                    borrower.collateral,
                    pool_state.liquidation_threshold_bps,
                    &oracle_state,
                )? < borrower.debt as u128
                {
                    borrower.liquidated = true;
                }

                Self::write_state(pool, &pool_state)?;
                Self::write_state(borrower_position, &borrower)?;
                Self::write_state(liquidator_position, &liquidator_state)
            }
        }
    }

    fn require_signer(account: &AccountInfo) -> Result<(), ProgramError> {
        if account.is_signer {
            Ok(())
        } else {
            Err(ProgramError::MissingRequiredSignature)
        }
    }

    fn assert_program_account(
        account: &AccountInfo,
        program_id: &Pubkey,
        expected_len: usize,
    ) -> Result<(), ProgramError> {
        if account.owner != program_id {
            return Err(LendingError::InvalidAccountOwner.into());
        }
        if account.data_len() < expected_len {
            return Err(LendingError::InvalidAccountData.into());
        }
        Ok(())
    }

    fn read_initialized_pool(account: &AccountInfo) -> Result<LendingPoolState, ProgramError> {
        let pool: LendingPoolState = Self::read_state(account)?;
        if pool.is_initialized {
            Ok(pool)
        } else {
            Err(LendingError::UninitializedPool.into())
        }
    }

    fn load_pool_oracle(
        program_id: &Pubkey,
        pool_state: &LendingPoolState,
        oracle_account: &AccountInfo,
    ) -> Result<OracleState, ProgramError> {
        Self::assert_program_account(oracle_account, program_id, ORACLE_STATE_LEN)?;
        if pool_state.oracle_pubkey() != *oracle_account.key {
            return Err(LendingError::Unauthorized.into());
        }
        let oracle: OracleState = Self::read_state(oracle_account)?;
        if oracle.is_initialized {
            Ok(oracle)
        } else {
            Err(LendingError::UninitializedOracle.into())
        }
    }

    fn read_state<T: BorshDeserialize>(account: &AccountInfo) -> Result<T, ProgramError> {
        T::try_from_slice(&account.try_borrow_data()?)
            .map_err(|_| LendingError::InvalidAccountData.into())
    }

    fn write_state<T: BorshSerialize>(account: &AccountInfo, state: &T) -> Result<(), ProgramError> {
        state
            .serialize(&mut &mut account.try_borrow_mut_data()?[..])
            .map_err(|_| LendingError::InvalidAccountData.into())
    }
}

#[cfg(test)]
mod tests {
    use borsh::to_vec;
    use solana_program::account_info::AccountInfo;

    use super::*;
    use crate::state::{LendingPoolConfig, LendingPoolState, OracleState, PositionState};

    struct TestAccount {
        key: &'static Pubkey,
        owner: &'static Pubkey,
        lamports: &'static mut u64,
        data: &'static mut [u8],
    }

    impl TestAccount {
        fn new(key: Pubkey, owner: Pubkey, len: usize) -> Self {
            Self {
                key: Box::leak(Box::new(key)),
                owner: Box::leak(Box::new(owner)),
                lamports: Box::leak(Box::new(0)),
                data: Box::leak(vec![0u8; len].into_boxed_slice()),
            }
        }

        fn info<'a>(&'a mut self, is_signer: bool) -> AccountInfo<'a> {
            AccountInfo::new(
                self.key,
                is_signer,
                true,
                self.lamports,
                self.data,
                self.owner,
                false,
                0,
            )
        }
    }

    fn write_account<T: BorshSerialize>(account: &mut TestAccount, state: &T) {
        state.serialize(&mut &mut account.data[..]).unwrap();
    }

    fn read_account<T: BorshDeserialize>(account: &TestAccount) -> T {
        T::try_from_slice(account.data).unwrap()
    }

    fn pool_config() -> crate::state::LendingPoolConfig {
        LendingPoolConfig {
            ltv_bps: 7_000,
            liquidation_threshold_bps: 8_000,
            liquidation_bonus_bps: 500,
            interest_bps: 250,
            deposit_limit: 1_000_000,
            borrow_limit: 1_000_000,
        }
    }

    fn setup_pool(program_id: Pubkey) -> (TestAccount, TestAccount, TestAccount, Pubkey) {
        let admin = Pubkey::new_unique();
        let mut oracle = TestAccount::new(Pubkey::new_unique(), program_id, ORACLE_STATE_LEN);
        let mut pool = TestAccount::new(Pubkey::new_unique(), program_id, POOL_STATE_LEN);

        write_account(
            &mut oracle,
            &OracleState {
                is_initialized: true,
                admin: admin.to_bytes(),
                price: 100,
                exponent: 0,
                reserved: [0; 8],
            },
        );
        write_account(
            &mut pool,
            &LendingPoolState {
                is_initialized: true,
                admin: admin.to_bytes(),
                oracle: oracle.key.to_bytes(),
                total_deposits: 0,
                total_borrows: 0,
                bad_debt: 0,
                ltv_bps: 7_000,
                liquidation_threshold_bps: 8_000,
                liquidation_bonus_bps: 500,
                interest_bps: 250,
                deposit_limit: 1_000_000,
                borrow_limit: 1_000_000,
            },
        );

        (oracle, pool, TestAccount::new(Pubkey::new_unique(), program_id, POSITION_STATE_LEN), admin)
    }

    #[test]
    fn deposit_increases_total_deposits() {
        let program_id = Pubkey::new_unique();
        let (_oracle, mut pool, mut position, owner) = setup_pool(program_id);
        let instruction = to_vec(&LendingInstructionData::Deposit { amount: 10_000 }).unwrap();
        let mut owner_lamports = 0;
        let mut owner_data = [];
        let owner_program = Pubkey::default();

        {
            let owner_info = AccountInfo::new(
                &owner,
                true,
                false,
                &mut owner_lamports,
                &mut owner_data,
                &owner_program,
                false,
                0,
            );
            let pool_info = pool.info(false);
            let position_info = position.info(false);
            Processor::process(&program_id, &[owner_info, pool_info, position_info], &instruction)
                .unwrap();
        }

        let pool_state: LendingPoolState = read_account(&pool);
        let position_state: PositionState = read_account(&position);
        assert_eq!(pool_state.total_deposits, 10_000);
        assert_eq!(position_state.collateral, 10_000);
    }

    #[test]
    fn price_drop_makes_position_liquidatable() {
        let program_id = Pubkey::new_unique();
        let (mut oracle, mut pool, mut position, owner) = setup_pool(program_id);
        write_account(
            &mut position,
            &PositionState {
                owner: owner.to_bytes(),
                collateral: 100,
                debt: 0,
                liquidated: false,
            },
        );
        let mut pool_state: LendingPoolState = read_account(&pool);
        pool_state.total_deposits = 100;
        write_account(&mut pool, &pool_state);

        let borrow_ix = to_vec(&LendingInstructionData::Borrow { amount: 7_000 }).unwrap();
        let mut owner_lamports = 0;
        let mut owner_data = [];
        let owner_program = Pubkey::default();
        {
            let owner_info = AccountInfo::new(
                &owner,
                true,
                false,
                &mut owner_lamports,
                &mut owner_data,
                &owner_program,
                false,
                0,
            );
            let pool_info = pool.info(false);
            let position_info = position.info(false);
            let oracle_info = oracle.info(false);
            Processor::process(
                &program_id,
                &[owner_info, pool_info, position_info, oracle_info],
                &borrow_ix,
            )
            .unwrap();
        }

        let mut oracle_state: OracleState = read_account(&oracle);
        oracle_state.price = 60;
        write_account(&mut oracle, &oracle_state);

        let borrower: PositionState = read_account(&position);
        let pool_state: LendingPoolState = read_account(&pool);
        let oracle_state: OracleState = read_account(&oracle);
        let health = health_factor_bps(&borrower, &pool_state, &oracle_state).unwrap();
        assert!(health < BPS_DENOMINATOR);
    }

    #[test]
    fn liquidation_marks_position_or_bad_debt() {
        let program_id = Pubkey::new_unique();
        let (mut oracle, mut pool, mut borrower_position, borrower_owner) = setup_pool(program_id);
        let mut liquidator_position =
            TestAccount::new(Pubkey::new_unique(), program_id, POSITION_STATE_LEN);
        write_account(
            &mut borrower_position,
            &PositionState {
                owner: borrower_owner.to_bytes(),
                collateral: 100,
                debt: 7_000,
                liquidated: false,
            },
        );
        let mut pool_state: LendingPoolState = read_account(&pool);
        pool_state.total_deposits = 100;
        pool_state.total_borrows = 7_000;
        write_account(&mut pool, &pool_state);

        let mut oracle_state: OracleState = read_account(&oracle);
        oracle_state.price = 60;
        write_account(&mut oracle, &oracle_state);

        let liquidator = Pubkey::new_unique();
        let liquidate_ix = to_vec(&LendingInstructionData::Liquidate { repay_amount: 7_000 }).unwrap();
        let mut liquidator_lamports = 0;
        let mut liquidator_data = [];
        let liquidator_owner = Pubkey::default();
        {
            let liquidator_info = AccountInfo::new(
                &liquidator,
                true,
                false,
                &mut liquidator_lamports,
                &mut liquidator_data,
                &liquidator_owner,
                false,
                0,
            );
            let pool_info = pool.info(false);
            let borrower_info = borrower_position.info(false);
            let liquidator_position_info = liquidator_position.info(false);
            let oracle_info = oracle.info(false);
            Processor::process(
                &program_id,
                &[
                    liquidator_info,
                    pool_info,
                    borrower_info,
                    liquidator_position_info,
                    oracle_info,
                ],
                &liquidate_ix,
            )
            .unwrap();
        }

        let borrower: PositionState = read_account(&borrower_position);
        let pool_state: LendingPoolState = read_account(&pool);
        assert!(borrower.liquidated || pool_state.bad_debt > 0);
    }

    #[test]
    fn state_sizes_match_harness_contract() {
        assert_eq!(to_vec(&PositionState::default()).unwrap().len(), POSITION_STATE_LEN);
        assert_eq!(
            to_vec(&OracleState {
                is_initialized: true,
                admin: [0; 32],
                price: 100,
                exponent: 0,
                reserved: [0; 8],
            })
            .unwrap()
            .len(),
            ORACLE_STATE_LEN
        );
        assert_eq!(
            to_vec(&LendingPoolState {
                is_initialized: true,
                admin: [0; 32],
                oracle: [0; 32],
                total_deposits: 0,
                total_borrows: 0,
                bad_debt: 0,
                ltv_bps: pool_config().ltv_bps,
                liquidation_threshold_bps: pool_config().liquidation_threshold_bps,
                liquidation_bonus_bps: pool_config().liquidation_bonus_bps,
                interest_bps: pool_config().interest_bps,
                deposit_limit: pool_config().deposit_limit,
                borrow_limit: pool_config().borrow_limit,
            })
            .unwrap()
            .len(),
            POOL_STATE_LEN
        );
    }
}
