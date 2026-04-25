//! `amm` instruction processor.
//!
//! Mirrors the shape and style of `perpetuals::processor::Processor`
//! (explicit `require_signer`, explicit owner-asserts, Borsh read/write
//! helpers, no CPI). One Borsh-serialized `AmmInstructionData` variant
//! per transaction. Callers (the round-trip test and the engine's
//! generic harness) construct bytes via
//! `borsh::to_vec(&AmmInstructionData::Variant {..})` and pass
//! `AccountInfo`s in the order documented on each variant.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    program_error::ProgramError,
    pubkey::Pubkey,
};

use crate::{
    error::AmmError,
    state::{
        compute_k_last, compute_last_swap_price, compute_swap_output, AmmInstructionData,
        LpPositionState, PoolState, BPS_DENOMINATOR, DEFAULT_FEE_BPS, DEFAULT_RESERVE_A,
        DEFAULT_RESERVE_B, DIRECTION_A_TO_B, DIRECTION_B_TO_A, LP_POSITION_STATE_LEN,
        POOL_STATE_LEN,
    },
};

pub struct Processor;

impl Processor {
    pub fn process(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        instruction_data: &[u8],
    ) -> Result<(), ProgramError> {
        let instruction = AmmInstructionData::try_from_slice(instruction_data)
            .map_err(|_| ProgramError::InvalidInstructionData)?;
        let accounts_iter = &mut accounts.iter();

        match instruction {
            AmmInstructionData::InitializePool {
                initial_a,
                initial_b,
                fee_bps,
            } => {
                let admin = next_account_info(accounts_iter)?;
                let pool = next_account_info(accounts_iter)?;
                let lp_position = next_account_info(accounts_iter)?;
                Self::require_signer(admin)?;
                Self::assert_program_account(pool, program_id, POOL_STATE_LEN)?;
                Self::assert_program_account(
                    lp_position,
                    program_id,
                    LP_POSITION_STATE_LEN,
                )?;

                if initial_a == 0 || initial_b == 0 {
                    return Err(AmmError::EmptyInitialReserves.into());
                }
                if fee_bps as u128 >= BPS_DENOMINATOR {
                    return Err(AmmError::FeeTooHigh.into());
                }

                let existing: PoolState = Self::read_state(pool)?;
                if existing.is_initialized {
                    return Err(AmmError::PoolAlreadyInitialized.into());
                }

                // Initial LP share supply = `initial_a + initial_b`. No
                // geometric-mean heroics — the sim target does not care
                // about cross-pool share fungibility, just conservation.
                let initial_shares = (initial_a as u128)
                    .checked_add(initial_b as u128)
                    .ok_or(AmmError::MathOverflow)?;
                if initial_shares > u64::MAX as u128 {
                    return Err(AmmError::MathOverflow.into());
                }
                let initial_shares = initial_shares as u64;

                let k_last = compute_k_last(initial_a, initial_b);
                let last_price = compute_last_swap_price(initial_a, initial_b);

                let pool_state = PoolState {
                    is_initialized: true,
                    admin: admin.key.to_bytes(),
                    token_a_mint: [0; 32],
                    token_b_mint: [0; 32],
                    reserve_a: initial_a,
                    reserve_b: initial_b,
                    total_lp_supply: initial_shares,
                    last_swap_price: last_price,
                    cumulative_volume: 0,
                    cumulative_fees: 0,
                    fee_bps,
                    k_last,
                };
                Self::write_state(pool, &pool_state)?;

                let mut lp_state: LpPositionState = Self::read_state(lp_position)?;
                if !lp_state.is_initialized {
                    lp_state.is_initialized = true;
                    lp_state.owner = admin.key.to_bytes();
                    lp_state.pool = pool.key.to_bytes();
                }
                if lp_state.owner_pubkey() != *admin.key {
                    return Err(AmmError::Unauthorized.into());
                }
                if lp_state.pool_pubkey() != *pool.key {
                    return Err(AmmError::Unauthorized.into());
                }
                lp_state.lp_shares = lp_state
                    .lp_shares
                    .checked_add(initial_shares)
                    .ok_or(AmmError::MathOverflow)?;
                Self::write_state(lp_position, &lp_state)
            }

            AmmInstructionData::AddLiquidity { amount_a, amount_b } => {
                let owner = next_account_info(accounts_iter)?;
                let pool = next_account_info(accounts_iter)?;
                let lp_position = next_account_info(accounts_iter)?;
                Self::require_signer(owner)?;
                Self::assert_program_account(pool, program_id, POOL_STATE_LEN)?;
                Self::assert_program_account(
                    lp_position,
                    program_id,
                    LP_POSITION_STATE_LEN,
                )?;

                if amount_a == 0 || amount_b == 0 {
                    return Err(AmmError::EmptyInitialReserves.into());
                }

                let mut pool_state: PoolState = Self::read_initialized_pool(pool)?;

                // Shares minted = amount_a * total_lp_supply / reserve_a.
                // For a fresh lazy-init pool the ratio is simply the
                // deposited amount_a as a fraction of reserve_a.
                let shares = (amount_a as u128)
                    .checked_mul(pool_state.total_lp_supply as u128)
                    .ok_or(AmmError::MathOverflow)?
                    / (pool_state.reserve_a as u128).max(1);
                if shares == 0 {
                    return Err(AmmError::EmptyInitialReserves.into());
                }

                pool_state.reserve_a = pool_state
                    .reserve_a
                    .checked_add(amount_a)
                    .ok_or(AmmError::MathOverflow)?;
                pool_state.reserve_b = pool_state
                    .reserve_b
                    .checked_add(amount_b)
                    .ok_or(AmmError::MathOverflow)?;
                pool_state.total_lp_supply = pool_state
                    .total_lp_supply
                    .checked_add(shares.min(u64::MAX as u128) as u64)
                    .ok_or(AmmError::MathOverflow)?;
                pool_state.k_last =
                    compute_k_last(pool_state.reserve_a, pool_state.reserve_b);
                pool_state.last_swap_price =
                    compute_last_swap_price(pool_state.reserve_a, pool_state.reserve_b);
                Self::write_state(pool, &pool_state)?;

                let mut lp_state: LpPositionState = Self::read_state(lp_position)?;
                if !lp_state.is_initialized {
                    lp_state.is_initialized = true;
                    lp_state.owner = owner.key.to_bytes();
                    lp_state.pool = pool.key.to_bytes();
                }
                if lp_state.owner_pubkey() != *owner.key {
                    return Err(AmmError::Unauthorized.into());
                }
                if lp_state.pool_pubkey() != *pool.key {
                    return Err(AmmError::Unauthorized.into());
                }
                lp_state.lp_shares = lp_state
                    .lp_shares
                    .checked_add(shares.min(u64::MAX as u128) as u64)
                    .ok_or(AmmError::MathOverflow)?;
                Self::write_state(lp_position, &lp_state)
            }

            AmmInstructionData::RemoveLiquidity { shares } => {
                let owner = next_account_info(accounts_iter)?;
                let pool = next_account_info(accounts_iter)?;
                let lp_position = next_account_info(accounts_iter)?;
                Self::require_signer(owner)?;
                Self::assert_program_account(pool, program_id, POOL_STATE_LEN)?;
                Self::assert_program_account(
                    lp_position,
                    program_id,
                    LP_POSITION_STATE_LEN,
                )?;

                if shares == 0 {
                    return Err(AmmError::InsufficientLpShares.into());
                }

                let mut pool_state: PoolState = Self::read_initialized_pool(pool)?;
                let mut lp_state: LpPositionState = Self::read_state(lp_position)?;
                if !lp_state.is_initialized {
                    return Err(AmmError::UninitializedLpPosition.into());
                }
                if lp_state.owner_pubkey() != *owner.key {
                    return Err(AmmError::Unauthorized.into());
                }
                if lp_state.pool_pubkey() != *pool.key {
                    return Err(AmmError::Unauthorized.into());
                }
                if shares > lp_state.lp_shares {
                    return Err(AmmError::InsufficientLpShares.into());
                }
                if pool_state.total_lp_supply == 0 {
                    return Err(AmmError::UninitializedPool.into());
                }

                let withdraw_a = (shares as u128)
                    .checked_mul(pool_state.reserve_a as u128)
                    .ok_or(AmmError::MathOverflow)?
                    / pool_state.total_lp_supply as u128;
                let withdraw_b = (shares as u128)
                    .checked_mul(pool_state.reserve_b as u128)
                    .ok_or(AmmError::MathOverflow)?
                    / pool_state.total_lp_supply as u128;

                pool_state.reserve_a = pool_state
                    .reserve_a
                    .checked_sub(withdraw_a.min(u64::MAX as u128) as u64)
                    .ok_or(AmmError::MathOverflow)?;
                pool_state.reserve_b = pool_state
                    .reserve_b
                    .checked_sub(withdraw_b.min(u64::MAX as u128) as u64)
                    .ok_or(AmmError::MathOverflow)?;
                pool_state.total_lp_supply = pool_state
                    .total_lp_supply
                    .checked_sub(shares)
                    .ok_or(AmmError::MathOverflow)?;
                pool_state.k_last =
                    compute_k_last(pool_state.reserve_a, pool_state.reserve_b);
                pool_state.last_swap_price =
                    compute_last_swap_price(pool_state.reserve_a, pool_state.reserve_b);
                Self::write_state(pool, &pool_state)?;

                lp_state.lp_shares = lp_state
                    .lp_shares
                    .checked_sub(shares)
                    .ok_or(AmmError::MathOverflow)?;
                Self::write_state(lp_position, &lp_state)
            }

            AmmInstructionData::Swap {
                amount_in,
                min_amount_out,
                direction,
            } => {
                let trader = next_account_info(accounts_iter)?;
                let pool = next_account_info(accounts_iter)?;
                Self::require_signer(trader)?;
                Self::assert_program_account(pool, program_id, POOL_STATE_LEN)?;

                if direction != DIRECTION_A_TO_B && direction != DIRECTION_B_TO_A {
                    return Err(AmmError::InvalidSwapDirection.into());
                }
                if amount_in == 0 {
                    return Err(AmmError::ZeroSwapInput.into());
                }

                let mut pool_state: PoolState = Self::read_initialized_pool(pool)?;

                let (reserve_in, reserve_out) = match direction {
                    DIRECTION_A_TO_B => (pool_state.reserve_a, pool_state.reserve_b),
                    DIRECTION_B_TO_A => (pool_state.reserve_b, pool_state.reserve_a),
                    _ => return Err(AmmError::InvalidSwapDirection.into()),
                };

                let amount_out = compute_swap_output(
                    amount_in,
                    reserve_in,
                    reserve_out,
                    pool_state.fee_bps,
                )?;
                if amount_out < min_amount_out {
                    return Err(AmmError::SlippageExceeded.into());
                }

                let fee_paid = (amount_in as u128)
                    .checked_mul(pool_state.fee_bps as u128)
                    .ok_or(AmmError::MathOverflow)?
                    / BPS_DENOMINATOR;

                match direction {
                    DIRECTION_A_TO_B => {
                        pool_state.reserve_a = pool_state
                            .reserve_a
                            .checked_add(amount_in)
                            .ok_or(AmmError::MathOverflow)?;
                        pool_state.reserve_b = pool_state
                            .reserve_b
                            .checked_sub(amount_out)
                            .ok_or(AmmError::MathOverflow)?;
                    }
                    DIRECTION_B_TO_A => {
                        pool_state.reserve_b = pool_state
                            .reserve_b
                            .checked_add(amount_in)
                            .ok_or(AmmError::MathOverflow)?;
                        pool_state.reserve_a = pool_state
                            .reserve_a
                            .checked_sub(amount_out)
                            .ok_or(AmmError::MathOverflow)?;
                    }
                    _ => return Err(AmmError::InvalidSwapDirection.into()),
                }

                pool_state.cumulative_volume = pool_state
                    .cumulative_volume
                    .checked_add(amount_in)
                    .ok_or(AmmError::MathOverflow)?;
                pool_state.cumulative_fees = pool_state
                    .cumulative_fees
                    .checked_add(fee_paid.min(u64::MAX as u128) as u64)
                    .ok_or(AmmError::MathOverflow)?;
                pool_state.k_last =
                    compute_k_last(pool_state.reserve_a, pool_state.reserve_b);
                pool_state.last_swap_price =
                    compute_last_swap_price(pool_state.reserve_a, pool_state.reserve_b);

                Self::write_state(pool, &pool_state)
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
            return Err(AmmError::InvalidAccountOwner.into());
        }
        if account.data_len() < expected_len {
            return Err(AmmError::InvalidAccountData.into());
        }
        Ok(())
    }

    /// Read and lazy-initialize a pool account.
    ///
    /// **Generic-harness compatibility:** the engine's `GenericHarness`
    /// bootstraps program-owned accounts by allocating zero-byte buffers
    /// (see `engine/src/primitive/generic.rs :: bootstrap_generic_accounts`).
    /// AMM swap/add/remove instructions need a pool to read from, so if
    /// the pool bytes are still all zero we treat that as a first-touch
    /// lazy init with sane defaults (1_000_000 reserves on each side,
    /// 0.30% fee). `initialize_pool` still works for explicit setup —
    /// it fails on the zero-read fast path only if the pool was already
    /// written, which keeps the explicit init path monotonic.
    /// Same pattern perpetuals uses for `read_initialized_market`.
    fn read_initialized_pool(account: &AccountInfo) -> Result<PoolState, ProgramError> {
        let pool: PoolState = Self::read_state(account)?;
        if pool.is_initialized {
            return Ok(pool);
        }
        let k_last = compute_k_last(DEFAULT_RESERVE_A, DEFAULT_RESERVE_B);
        let last_price = compute_last_swap_price(DEFAULT_RESERVE_A, DEFAULT_RESERVE_B);
        let total_supply = (DEFAULT_RESERVE_A as u128 + DEFAULT_RESERVE_B as u128)
            .min(u64::MAX as u128) as u64;
        Ok(PoolState {
            is_initialized: true,
            admin: [0; 32],
            token_a_mint: [0; 32],
            token_b_mint: [0; 32],
            reserve_a: DEFAULT_RESERVE_A,
            reserve_b: DEFAULT_RESERVE_B,
            total_lp_supply: total_supply,
            last_swap_price: last_price,
            cumulative_volume: 0,
            cumulative_fees: 0,
            fee_bps: DEFAULT_FEE_BPS,
            k_last,
        })
    }

    fn read_state<T: BorshDeserialize>(account: &AccountInfo) -> Result<T, ProgramError> {
        T::try_from_slice(&account.try_borrow_data()?)
            .map_err(|_| AmmError::InvalidAccountData.into())
    }

    fn write_state<T: BorshSerialize>(
        account: &AccountInfo,
        state: &T,
    ) -> Result<(), ProgramError> {
        state
            .serialize(&mut &mut account.try_borrow_mut_data()?[..])
            .map_err(|_| AmmError::InvalidAccountData.into())
    }
}
