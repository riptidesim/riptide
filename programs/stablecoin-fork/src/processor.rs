//! `stablecoin-fork` instruction processor.
//!
//! Mirrors the shape of perps-fork / amm-fork / liquid-staking-fork:
//! explicit `require_signer`, explicit owner-asserts, Borsh read/write
//! helpers, no CPI, no derived-address magic. One Borsh-serialized
//! `StablecoinInstructionData` variant per transaction.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    program_error::ProgramError,
    pubkey::Pubkey,
};

use crate::{
    error::StablecoinError,
    state::{
        apply_bps, recompute_collateral_ratio, PoolState, PositionState,
        StablecoinInstructionData, BPS_DENOMINATOR, DEFAULT_COLLATERAL_RATIO_BPS, POOL_STATE_LEN,
        POSITION_STATE_LEN, RESERVE_FRACTION_BPS,
    },
};

pub struct Processor;

impl Processor {
    pub fn process(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        instruction_data: &[u8],
    ) -> Result<(), ProgramError> {
        let instruction = StablecoinInstructionData::try_from_slice(instruction_data)
            .map_err(|_| ProgramError::InvalidInstructionData)?;
        let accounts_iter = &mut accounts.iter();

        match instruction {
            StablecoinInstructionData::InitializePool => {
                let admin = next_account_info(accounts_iter)?;
                let pool = next_account_info(accounts_iter)?;
                let oracle = next_account_info(accounts_iter)?;
                Self::require_signer(admin)?;
                Self::assert_program_account(pool, program_id, POOL_STATE_LEN)?;

                let existing: PoolState = Self::read_state(pool)?;
                if existing.is_initialized {
                    return Err(StablecoinError::PoolAlreadyInitialized.into());
                }

                let state = PoolState {
                    is_initialized: true,
                    admin: admin.key.to_bytes(),
                    oracle: oracle.key.to_bytes(),
                    collateral_assets: 0,
                    stable_supply: 0,
                    reserve_buffer_assets: 0,
                    pending_redemption_assets: 0,
                    pending_redemption_count: 0,
                    effective_collateral_ratio_bps: DEFAULT_COLLATERAL_RATIO_BPS,
                    cumulative_hedge_loss_bps: 0,
                };
                Self::write_state(pool, &state)
            }

            StablecoinInstructionData::DepositCollateral { amount } => {
                let owner = next_account_info(accounts_iter)?;
                let pool = next_account_info(accounts_iter)?;
                let position = next_account_info(accounts_iter)?;
                Self::require_signer(owner)?;
                Self::assert_program_account(pool, program_id, POOL_STATE_LEN)?;
                Self::assert_program_account(position, program_id, POSITION_STATE_LEN)?;

                if amount == 0 {
                    return Err(StablecoinError::ZeroAmount.into());
                }

                let mut pool_state: PoolState = Self::read_initialized_pool(pool)?;
                let mut pos: PositionState = Self::read_state(position)?;

                if !pos.is_initialized {
                    pos.is_initialized = true;
                    pos.owner = owner.key.to_bytes();
                    pos.pool = pool.key.to_bytes();
                }
                if pos.owner_pubkey() != *owner.key {
                    return Err(StablecoinError::Unauthorized.into());
                }
                if pos.pool_pubkey() != *pool.key {
                    return Err(StablecoinError::Unauthorized.into());
                }

                // Split the deposit: `RESERVE_FRACTION_BPS` goes to
                // the liquid buffer, the rest is treated as delegated
                // / hedge-engaged collateral. This is what creates
                // organic redemption-queue pressure: a redemption
                // larger than the reserve fraction of total deposits
                // cannot settle from the buffer and falls to the
                // queue in `RequestRedeem`.
                let reserve_portion = apply_bps(amount, RESERVE_FRACTION_BPS)?;

                pool_state.collateral_assets = pool_state
                    .collateral_assets
                    .checked_add(amount)
                    .ok_or(StablecoinError::MathOverflow)?;
                pool_state.reserve_buffer_assets = pool_state
                    .reserve_buffer_assets
                    .checked_add(reserve_portion)
                    .ok_or(StablecoinError::MathOverflow)?;

                pos.collateral_deposited = pos
                    .collateral_deposited
                    .checked_add(amount)
                    .ok_or(StablecoinError::MathOverflow)?;

                pool_state.effective_collateral_ratio_bps = recompute_collateral_ratio(
                    pool_state.collateral_assets,
                    pool_state.stable_supply,
                    pool_state.pending_redemption_assets,
                );

                Self::write_state(pool, &pool_state)?;
                Self::write_state(position, &pos)
            }

            StablecoinInstructionData::MintStable { amount } => {
                let owner = next_account_info(accounts_iter)?;
                let pool = next_account_info(accounts_iter)?;
                let position = next_account_info(accounts_iter)?;
                Self::require_signer(owner)?;
                Self::assert_program_account(pool, program_id, POOL_STATE_LEN)?;
                Self::assert_program_account(position, program_id, POSITION_STATE_LEN)?;

                if amount == 0 {
                    return Err(StablecoinError::ZeroAmount.into());
                }

                let mut pool_state: PoolState = Self::read_initialized_pool(pool)?;
                let mut pos: PositionState = Self::read_state(position)?;

                if !pos.is_initialized {
                    return Err(StablecoinError::UninitializedPosition.into());
                }
                if pos.owner_pubkey() != *owner.key {
                    return Err(StablecoinError::Unauthorized.into());
                }
                if pos.pool_pubkey() != *pool.key {
                    return Err(StablecoinError::Unauthorized.into());
                }
                if pos.free_collateral() < amount {
                    return Err(StablecoinError::InsufficientFreeCollateral.into());
                }

                pos.stable_minted = pos
                    .stable_minted
                    .checked_add(amount)
                    .ok_or(StablecoinError::MathOverflow)?;
                pool_state.stable_supply = pool_state
                    .stable_supply
                    .checked_add(amount)
                    .ok_or(StablecoinError::MathOverflow)?;

                pool_state.effective_collateral_ratio_bps = recompute_collateral_ratio(
                    pool_state.collateral_assets,
                    pool_state.stable_supply,
                    pool_state.pending_redemption_assets,
                );

                Self::write_state(pool, &pool_state)?;
                Self::write_state(position, &pos)
            }

            StablecoinInstructionData::RequestRedeem { stable_amount } => {
                let owner = next_account_info(accounts_iter)?;
                let pool = next_account_info(accounts_iter)?;
                let position = next_account_info(accounts_iter)?;
                Self::require_signer(owner)?;
                Self::assert_program_account(pool, program_id, POOL_STATE_LEN)?;
                Self::assert_program_account(position, program_id, POSITION_STATE_LEN)?;

                if stable_amount == 0 {
                    return Err(StablecoinError::ZeroAmount.into());
                }

                let mut pool_state: PoolState = Self::read_initialized_pool(pool)?;
                let mut pos: PositionState = Self::read_state(position)?;

                if !pos.is_initialized {
                    return Err(StablecoinError::UninitializedPosition.into());
                }
                if pos.owner_pubkey() != *owner.key {
                    return Err(StablecoinError::Unauthorized.into());
                }
                if pos.pool_pubkey() != *pool.key {
                    return Err(StablecoinError::Unauthorized.into());
                }
                if stable_amount > pos.stable_minted {
                    return Err(StablecoinError::InsufficientStableBalance.into());
                }

                // 1:1 stable-to-collateral redemption accounting. The
                // hedge-loss haircut lands on the pool (collateral_assets
                // shrinks) rather than the per-unit redemption price —
                // keeps agent-level math trivial while still letting
                // the pool go under-backed.
                let assets_owed = stable_amount;

                // Burn stable up front — the liability shifts from
                // supply to either claimable_collateral (reserve
                // covered) or pending_redeem_assets (queued).
                pos.stable_minted = pos
                    .stable_minted
                    .checked_sub(stable_amount)
                    .ok_or(StablecoinError::MathOverflow)?;
                pool_state.stable_supply = pool_state
                    .stable_supply
                    .checked_sub(stable_amount)
                    .ok_or(StablecoinError::MathOverflow)?;

                if pool_state.reserve_buffer_assets >= assets_owed {
                    pool_state.reserve_buffer_assets = pool_state
                        .reserve_buffer_assets
                        .checked_sub(assets_owed)
                        .ok_or(StablecoinError::MathOverflow)?;
                    pool_state.collateral_assets = pool_state
                        .collateral_assets
                        .checked_sub(assets_owed)
                        .ok_or(StablecoinError::MathOverflow)?;
                    pos.collateral_deposited = pos
                        .collateral_deposited
                        .saturating_sub(assets_owed);
                    pos.claimable_collateral = pos
                        .claimable_collateral
                        .checked_add(assets_owed)
                        .ok_or(StablecoinError::MathOverflow)?;
                } else {
                    // `pending_redemption_count` counts POSITIONS with
                    // non-zero pending, not individual request_redeem
                    // calls. Only bump the counter when this position
                    // is transitioning from zero to positive pending —
                    // repeat queued requests on an already-queued
                    // position aggregate into the same position-level
                    // pending balance and must not double-count at the
                    // pool level (same discipline liquid-staking-fork
                    // uses; a `claim_redeem` settles the aggregate
                    // once and decrements once).
                    let was_unqueued = pos.pending_redeem_assets == 0;
                    pos.pending_redeem_assets = pos
                        .pending_redeem_assets
                        .checked_add(assets_owed)
                        .ok_or(StablecoinError::MathOverflow)?;
                    pool_state.pending_redemption_assets = pool_state
                        .pending_redemption_assets
                        .checked_add(assets_owed)
                        .ok_or(StablecoinError::MathOverflow)?;
                    if was_unqueued {
                        pool_state.pending_redemption_count = pool_state
                            .pending_redemption_count
                            .checked_add(1)
                            .ok_or(StablecoinError::MathOverflow)?;
                    }
                }

                pool_state.effective_collateral_ratio_bps = recompute_collateral_ratio(
                    pool_state.collateral_assets,
                    pool_state.stable_supply,
                    pool_state.pending_redemption_assets,
                );

                Self::write_state(pool, &pool_state)?;
                Self::write_state(position, &pos)
            }

            StablecoinInstructionData::ClaimRedeem => {
                let owner = next_account_info(accounts_iter)?;
                let pool = next_account_info(accounts_iter)?;
                let position = next_account_info(accounts_iter)?;
                Self::require_signer(owner)?;
                Self::assert_program_account(pool, program_id, POOL_STATE_LEN)?;
                Self::assert_program_account(position, program_id, POSITION_STATE_LEN)?;

                let mut pool_state: PoolState = Self::read_initialized_pool(pool)?;
                let mut pos: PositionState = Self::read_state(position)?;

                if !pos.is_initialized {
                    return Err(StablecoinError::UninitializedPosition.into());
                }
                if pos.owner_pubkey() != *owner.key {
                    return Err(StablecoinError::Unauthorized.into());
                }
                if pos.pool_pubkey() != *pool.key {
                    return Err(StablecoinError::Unauthorized.into());
                }

                let mut paid: u64 = 0;

                // First flush any immediately-claimable balance.
                if pos.claimable_collateral > 0 {
                    paid = paid
                        .checked_add(pos.claimable_collateral)
                        .ok_or(StablecoinError::MathOverflow)?;
                    pos.claimable_collateral = 0;
                }

                // Then, if reserve has caught up, settle queued.
                if pos.pending_redeem_assets > 0
                    && pool_state.reserve_buffer_assets >= pos.pending_redeem_assets
                {
                    let pending = pos.pending_redeem_assets;
                    pool_state.reserve_buffer_assets = pool_state
                        .reserve_buffer_assets
                        .checked_sub(pending)
                        .ok_or(StablecoinError::MathOverflow)?;
                    pool_state.collateral_assets = pool_state
                        .collateral_assets
                        .checked_sub(pending)
                        .ok_or(StablecoinError::MathOverflow)?;
                    pool_state.pending_redemption_assets = pool_state
                        .pending_redemption_assets
                        .checked_sub(pending)
                        .ok_or(StablecoinError::MathOverflow)?;
                    pool_state.pending_redemption_count =
                        pool_state.pending_redemption_count.saturating_sub(1);
                    pos.collateral_deposited = pos.collateral_deposited.saturating_sub(pending);
                    pos.pending_redeem_assets = 0;
                    paid = paid
                        .checked_add(pending)
                        .ok_or(StablecoinError::MathOverflow)?;
                }

                if paid == 0 {
                    return Err(StablecoinError::NothingToClaim.into());
                }

                pos.cumulative_claimed = pos
                    .cumulative_claimed
                    .checked_add(paid)
                    .ok_or(StablecoinError::MathOverflow)?;

                pool_state.effective_collateral_ratio_bps = recompute_collateral_ratio(
                    pool_state.collateral_assets,
                    pool_state.stable_supply,
                    pool_state.pending_redemption_assets,
                );

                Self::write_state(pool, &pool_state)?;
                Self::write_state(position, &pos)
            }

            StablecoinInstructionData::ApplyHedgeLoss { loss_bps } => {
                let admin = next_account_info(accounts_iter)?;
                let pool = next_account_info(accounts_iter)?;
                Self::require_signer(admin)?;
                Self::assert_program_account(pool, program_id, POOL_STATE_LEN)?;

                if loss_bps == 0 || (loss_bps as u128) > BPS_DENOMINATOR {
                    return Err(StablecoinError::InvalidHedgeLossBps.into());
                }

                let mut pool_state: PoolState = Self::read_initialized_pool(pool)?;

                // Strict authority gate. An unset admin ([0;32]) means
                // the pool was lazy-initialized through the generic
                // harness's zero-byte bootstrap and has never named an
                // owner — in that state `apply_hedge_loss` is NOT a
                // valid operation. Explicit `initialize_pool` must pin
                // an admin before any haircut can fire. Closes the
                // same "any signer works when admin is unset" hole
                // liquid-staking-fork closed.
                if pool_state.admin == [0u8; 32] {
                    return Err(StablecoinError::Unauthorized.into());
                }
                if pool_state.admin_pubkey() != *admin.key {
                    return Err(StablecoinError::Unauthorized.into());
                }

                // Haircut hits delegated collateral only
                // (`collateral_assets - reserve_buffer_assets`). The
                // real-world analogue: liquid cash in the protocol's
                // hot wallet is not what a hedge-venue failure
                // destroys — it destroys the off-program delta hedge,
                // which was backing the delegated portion of the
                // pool. Preserves
                // `reserve_buffer_assets <= collateral_assets` as a
                // natural invariant and keeps the depeg signal honest.
                let delegated = pool_state
                    .collateral_assets
                    .saturating_sub(pool_state.reserve_buffer_assets);
                let loss_amount = apply_bps(delegated, loss_bps)?;

                pool_state.collateral_assets =
                    pool_state.collateral_assets.saturating_sub(loss_amount);
                pool_state.cumulative_hedge_loss_bps = pool_state
                    .cumulative_hedge_loss_bps
                    .checked_add(loss_bps)
                    .ok_or(StablecoinError::MathOverflow)?;

                pool_state.effective_collateral_ratio_bps = recompute_collateral_ratio(
                    pool_state.collateral_assets,
                    pool_state.stable_supply,
                    pool_state.pending_redemption_assets,
                );

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
            return Err(StablecoinError::InvalidAccountOwner.into());
        }
        if account.data_len() < expected_len {
            return Err(StablecoinError::InvalidAccountData.into());
        }
        Ok(())
    }

    /// Lazy-init path for the generic harness. When
    /// `bootstrap_generic_accounts` allocates zero-byte buffers, the
    /// first instruction that reads the pool sees an uninitialized
    /// state and falls back on sane defaults. Explicit
    /// `InitializePool` is still supported and writes through the
    /// same shape. Same pattern liquid-staking-fork uses.
    fn read_initialized_pool(account: &AccountInfo) -> Result<PoolState, ProgramError> {
        let pool: PoolState = Self::read_state(account)?;
        if pool.is_initialized {
            return Ok(pool);
        }
        Ok(PoolState {
            is_initialized: true,
            admin: [0; 32],
            oracle: [0; 32],
            collateral_assets: 0,
            stable_supply: 0,
            reserve_buffer_assets: 0,
            pending_redemption_assets: 0,
            pending_redemption_count: 0,
            effective_collateral_ratio_bps: DEFAULT_COLLATERAL_RATIO_BPS,
            cumulative_hedge_loss_bps: 0,
        })
    }

    fn read_state<T: BorshDeserialize>(account: &AccountInfo) -> Result<T, ProgramError> {
        T::try_from_slice(&account.try_borrow_data()?)
            .map_err(|_| StablecoinError::InvalidAccountData.into())
    }

    fn write_state<T: BorshSerialize>(
        account: &AccountInfo,
        state: &T,
    ) -> Result<(), ProgramError> {
        state
            .serialize(&mut &mut account.try_borrow_mut_data()?[..])
            .map_err(|_| StablecoinError::InvalidAccountData.into())
    }
}
