//! `liquid-staking` instruction processor.
//!
//! Mirrors the shape of `perpetuals` / `amm`: explicit
//! `require_signer`, explicit owner-asserts, Borsh read/write helpers,
//! no CPI, no derived-address magic. One Borsh-serialized
//! `LiquidStakingInstructionData` variant per transaction.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    program_error::ProgramError,
    pubkey::Pubkey,
};

use crate::{
    error::LiquidStakingError,
    state::{
        assets_to_lst, lst_to_assets, recompute_exchange_rate, LiquidStakingInstructionData,
        PoolState, StakeAccountState, BPS_DENOMINATOR, DEFAULT_EXCHANGE_RATE_BPS,
        POOL_STATE_LEN, RESERVE_FRACTION_BPS, STAKE_ACCOUNT_LEN,
    },
};

pub struct Processor;

impl Processor {
    pub fn process(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        instruction_data: &[u8],
    ) -> Result<(), ProgramError> {
        let instruction = LiquidStakingInstructionData::try_from_slice(instruction_data)
            .map_err(|_| ProgramError::InvalidInstructionData)?;
        let accounts_iter = &mut accounts.iter();

        match instruction {
            LiquidStakingInstructionData::InitializePool {
                initial_exchange_rate_bps,
            } => {
                let admin = next_account_info(accounts_iter)?;
                let pool = next_account_info(accounts_iter)?;
                let oracle = next_account_info(accounts_iter)?;
                Self::require_signer(admin)?;
                Self::assert_program_account(pool, program_id, POOL_STATE_LEN)?;

                let existing: PoolState = Self::read_state(pool)?;
                if existing.is_initialized {
                    return Err(LiquidStakingError::PoolAlreadyInitialized.into());
                }

                let exchange_rate_bps = if initial_exchange_rate_bps == 0 {
                    DEFAULT_EXCHANGE_RATE_BPS
                } else {
                    initial_exchange_rate_bps
                };

                let state = PoolState {
                    is_initialized: true,
                    admin: admin.key.to_bytes(),
                    oracle: oracle.key.to_bytes(),
                    total_assets: 0,
                    lst_supply: 0,
                    reserve_buffer: 0,
                    pending_unstake_assets: 0,
                    pending_unstake_count: 0,
                    exchange_rate_bps,
                    cumulative_slashed: 0,
                };
                Self::write_state(pool, &state)
            }

            LiquidStakingInstructionData::Stake { amount } => {
                let owner = next_account_info(accounts_iter)?;
                let pool = next_account_info(accounts_iter)?;
                let stake_account = next_account_info(accounts_iter)?;
                Self::require_signer(owner)?;
                Self::assert_program_account(pool, program_id, POOL_STATE_LEN)?;
                Self::assert_program_account(stake_account, program_id, STAKE_ACCOUNT_LEN)?;

                if amount == 0 {
                    return Err(LiquidStakingError::ZeroAmount.into());
                }

                let mut pool_state: PoolState = Self::read_initialized_pool(pool)?;
                let mut acct: StakeAccountState = Self::read_state(stake_account)?;

                if !acct.is_initialized {
                    acct.is_initialized = true;
                    acct.owner = owner.key.to_bytes();
                    acct.pool = pool.key.to_bytes();
                }
                if acct.owner_pubkey() != *owner.key {
                    return Err(LiquidStakingError::Unauthorized.into());
                }
                if acct.pool_pubkey() != *pool.key {
                    return Err(LiquidStakingError::Unauthorized.into());
                }

                let lst_minted = assets_to_lst(amount, pool_state.exchange_rate_bps)?;
                if lst_minted == 0 {
                    return Err(LiquidStakingError::ZeroAmount.into());
                }

                // Split the deposit: `RESERVE_FRACTION_BPS` goes to
                // liquid buffer, the rest is treated as delegated stake
                // (grows `total_assets` only). This is what creates
                // organic withdrawal-queue pressure: any redemption
                // larger than the reserve fraction of total stake
                // cannot settle from the buffer and falls to the
                // queue in `RequestUnstake`.
                let reserve_portion_u128 = (amount as u128)
                    .checked_mul(RESERVE_FRACTION_BPS as u128)
                    .ok_or(LiquidStakingError::MathOverflow)?
                    / BPS_DENOMINATOR;
                let reserve_portion = reserve_portion_u128.min(u64::MAX as u128) as u64;

                pool_state.total_assets = pool_state
                    .total_assets
                    .checked_add(amount)
                    .ok_or(LiquidStakingError::MathOverflow)?;
                pool_state.reserve_buffer = pool_state
                    .reserve_buffer
                    .checked_add(reserve_portion)
                    .ok_or(LiquidStakingError::MathOverflow)?;
                pool_state.lst_supply = pool_state
                    .lst_supply
                    .checked_add(lst_minted)
                    .ok_or(LiquidStakingError::MathOverflow)?;

                acct.lst_balance = acct
                    .lst_balance
                    .checked_add(lst_minted)
                    .ok_or(LiquidStakingError::MathOverflow)?;

                Self::write_state(pool, &pool_state)?;
                Self::write_state(stake_account, &acct)
            }

            LiquidStakingInstructionData::RequestUnstake { lst_amount } => {
                let owner = next_account_info(accounts_iter)?;
                let pool = next_account_info(accounts_iter)?;
                let stake_account = next_account_info(accounts_iter)?;
                Self::require_signer(owner)?;
                Self::assert_program_account(pool, program_id, POOL_STATE_LEN)?;
                Self::assert_program_account(stake_account, program_id, STAKE_ACCOUNT_LEN)?;

                if lst_amount == 0 {
                    return Err(LiquidStakingError::ZeroAmount.into());
                }

                let mut pool_state: PoolState = Self::read_initialized_pool(pool)?;
                let mut acct: StakeAccountState = Self::read_state(stake_account)?;

                if !acct.is_initialized {
                    return Err(LiquidStakingError::UninitializedStakeAccount.into());
                }
                if acct.owner_pubkey() != *owner.key {
                    return Err(LiquidStakingError::Unauthorized.into());
                }
                if acct.pool_pubkey() != *pool.key {
                    return Err(LiquidStakingError::Unauthorized.into());
                }
                if lst_amount > acct.lst_balance {
                    return Err(LiquidStakingError::InsufficientLstBalance.into());
                }

                let assets_owed = lst_to_assets(lst_amount, pool_state.exchange_rate_bps)?;

                // Burn LST up front — the liability shifts from LST
                // supply to either claimable_assets (if reserve covers
                // it) or pending_unstake_assets (if queued).
                acct.lst_balance = acct
                    .lst_balance
                    .checked_sub(lst_amount)
                    .ok_or(LiquidStakingError::MathOverflow)?;
                pool_state.lst_supply = pool_state
                    .lst_supply
                    .checked_sub(lst_amount)
                    .ok_or(LiquidStakingError::MathOverflow)?;

                if pool_state.reserve_buffer >= assets_owed {
                    pool_state.reserve_buffer = pool_state
                        .reserve_buffer
                        .checked_sub(assets_owed)
                        .ok_or(LiquidStakingError::MathOverflow)?;
                    pool_state.total_assets = pool_state
                        .total_assets
                        .checked_sub(assets_owed)
                        .ok_or(LiquidStakingError::MathOverflow)?;
                    acct.claimable_assets = acct
                        .claimable_assets
                        .checked_add(assets_owed)
                        .ok_or(LiquidStakingError::MathOverflow)?;
                } else {
                    // `pending_unstake_count` counts ACCOUNTS holding
                    // a non-zero pending balance, not individual
                    // request_unstake calls. Only bump the counter
                    // when this account is transitioning from zero
                    // to positive pending — repeat queued requests
                    // on an already-queued account aggregate into
                    // the same account-level pending balance and
                    // must NOT double-count at the pool level, or a
                    // later `claim_unstake` (which only settles the
                    // aggregate) would decrement once and leave a
                    // phantom queue entry behind.
                    let was_unqueued = acct.pending_unstake_assets == 0;
                    acct.pending_unstake_assets = acct
                        .pending_unstake_assets
                        .checked_add(assets_owed)
                        .ok_or(LiquidStakingError::MathOverflow)?;
                    pool_state.pending_unstake_assets = pool_state
                        .pending_unstake_assets
                        .checked_add(assets_owed)
                        .ok_or(LiquidStakingError::MathOverflow)?;
                    if was_unqueued {
                        pool_state.pending_unstake_count = pool_state
                            .pending_unstake_count
                            .checked_add(1)
                            .ok_or(LiquidStakingError::MathOverflow)?;
                    }
                }

                Self::write_state(pool, &pool_state)?;
                Self::write_state(stake_account, &acct)
            }

            LiquidStakingInstructionData::ClaimUnstake => {
                let owner = next_account_info(accounts_iter)?;
                let pool = next_account_info(accounts_iter)?;
                let stake_account = next_account_info(accounts_iter)?;
                Self::require_signer(owner)?;
                Self::assert_program_account(pool, program_id, POOL_STATE_LEN)?;
                Self::assert_program_account(stake_account, program_id, STAKE_ACCOUNT_LEN)?;

                let mut pool_state: PoolState = Self::read_initialized_pool(pool)?;
                let mut acct: StakeAccountState = Self::read_state(stake_account)?;

                if !acct.is_initialized {
                    return Err(LiquidStakingError::UninitializedStakeAccount.into());
                }
                if acct.owner_pubkey() != *owner.key {
                    return Err(LiquidStakingError::Unauthorized.into());
                }
                if acct.pool_pubkey() != *pool.key {
                    return Err(LiquidStakingError::Unauthorized.into());
                }

                let mut paid: u64 = 0;

                // First flush any immediately-claimable balance.
                if acct.claimable_assets > 0 {
                    paid = paid
                        .checked_add(acct.claimable_assets)
                        .ok_or(LiquidStakingError::MathOverflow)?;
                    acct.claimable_assets = 0;
                }

                // Then, if reserve liquidity has caught up, settle the
                // queued portion.
                if acct.pending_unstake_assets > 0
                    && pool_state.reserve_buffer >= acct.pending_unstake_assets
                {
                    let pending = acct.pending_unstake_assets;
                    pool_state.reserve_buffer = pool_state
                        .reserve_buffer
                        .checked_sub(pending)
                        .ok_or(LiquidStakingError::MathOverflow)?;
                    pool_state.total_assets = pool_state
                        .total_assets
                        .checked_sub(pending)
                        .ok_or(LiquidStakingError::MathOverflow)?;
                    pool_state.pending_unstake_assets = pool_state
                        .pending_unstake_assets
                        .checked_sub(pending)
                        .ok_or(LiquidStakingError::MathOverflow)?;
                    pool_state.pending_unstake_count =
                        pool_state.pending_unstake_count.saturating_sub(1);
                    acct.pending_unstake_assets = 0;
                    paid = paid
                        .checked_add(pending)
                        .ok_or(LiquidStakingError::MathOverflow)?;
                }

                if paid == 0 {
                    return Err(LiquidStakingError::NothingToClaim.into());
                }

                acct.cumulative_claimed = acct
                    .cumulative_claimed
                    .checked_add(paid)
                    .ok_or(LiquidStakingError::MathOverflow)?;

                Self::write_state(pool, &pool_state)?;
                Self::write_state(stake_account, &acct)
            }

            LiquidStakingInstructionData::AdminMintLst { amount } => {
                let admin = next_account_info(accounts_iter)?;
                let pool = next_account_info(accounts_iter)?;
                Self::require_signer(admin)?;
                Self::assert_program_account(pool, program_id, POOL_STATE_LEN)?;

                if amount == 0 {
                    return Ok(());
                }

                let mut pool_state: PoolState = Self::read_initialized_pool(pool)?;

                if pool_state.admin == [0u8; 32] {
                    return Err(LiquidStakingError::Unauthorized.into());
                }
                if pool_state.admin_pubkey() != *admin.key {
                    return Err(LiquidStakingError::Unauthorized.into());
                }

                // Mint LST into circulation without depositing underlying
                // and without recomputing the exchange rate. Mirrors
                // KelpDAO's bridge-trust failure: an unauthorized mint
                // path produced rsETH that no real ETH was ever staked
                // for. After this returns, lst_supply * exchange_rate_bps
                // exceeds total_assets * 10000 — exactly the `full_backing`
                // invariant the proof pack asserts on.
                pool_state.lst_supply = pool_state
                    .lst_supply
                    .checked_add(amount)
                    .ok_or(LiquidStakingError::MathOverflow)?;

                Self::write_state(pool, &pool_state)
            }

            LiquidStakingInstructionData::ApplySlash { slash_bps } => {
                let admin = next_account_info(accounts_iter)?;
                let pool = next_account_info(accounts_iter)?;
                Self::require_signer(admin)?;
                Self::assert_program_account(pool, program_id, POOL_STATE_LEN)?;

                if slash_bps == 0 || (slash_bps as u128) > BPS_DENOMINATOR {
                    return Err(LiquidStakingError::InvalidSlashBps.into());
                }

                let mut pool_state: PoolState = Self::read_initialized_pool(pool)?;

                // Strict authority gate. An unset admin ([0;32]) means
                // the pool was lazy-initialized through the generic
                // harness's zero-byte bootstrap and has never named an
                // owner — in that state `apply_slash` is NOT a valid
                // operation. Explicit `initialize_pool` must pin an
                // admin before any slash can fire. Previously this
                // branch allowed any signer when the admin was unset,
                // which silently removed the authority gate on every
                // adapter that relied on the lazy-init path — the
                // exact path the adapter uses.
                if pool_state.admin == [0u8; 32] {
                    return Err(LiquidStakingError::Unauthorized.into());
                }
                if pool_state.admin_pubkey() != *admin.key {
                    return Err(LiquidStakingError::Unauthorized.into());
                }

                // Slash hits the delegated portion of the pool only
                // (total_assets - reserve_buffer). Real LST slashing
                // events destroy validator-delegated stake; cash sitting
                // in the liquid reserve is not at risk. This preserves
                // `reserve_buffer <= total_assets` as a natural invariant
                // and keeps the post-slash depeg signal honest — rate
                // drops because the pool shrank while LST supply didn't.
                let delegated = pool_state
                    .total_assets
                    .saturating_sub(pool_state.reserve_buffer);
                let slash_amount = (delegated as u128)
                    .checked_mul(slash_bps as u128)
                    .ok_or(LiquidStakingError::MathOverflow)?
                    / BPS_DENOMINATOR;
                let slash_amount = slash_amount.min(u64::MAX as u128) as u64;

                pool_state.total_assets =
                    pool_state.total_assets.saturating_sub(slash_amount);
                pool_state.cumulative_slashed = pool_state
                    .cumulative_slashed
                    .checked_add(slash_amount)
                    .ok_or(LiquidStakingError::MathOverflow)?;
                pool_state.exchange_rate_bps = recompute_exchange_rate(
                    pool_state.total_assets,
                    pool_state.lst_supply,
                    pool_state.pending_unstake_assets,
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
            return Err(LiquidStakingError::InvalidAccountOwner.into());
        }
        if account.data_len() < expected_len {
            return Err(LiquidStakingError::InvalidAccountData.into());
        }
        Ok(())
    }

    /// Lazy-init path for the generic harness. When `bootstrap_generic_accounts`
    /// allocates zero-byte buffers, the first instruction that reads the
    /// pool sees an uninitialized state and falls back on sane defaults.
    /// Explicit `InitializePool` is still supported and writes through
    /// the same shape. Same pattern perpetuals and amm use.
    fn read_initialized_pool(account: &AccountInfo) -> Result<PoolState, ProgramError> {
        let pool: PoolState = Self::read_state(account)?;
        if pool.is_initialized {
            return Ok(pool);
        }
        Ok(PoolState {
            is_initialized: true,
            admin: [0; 32],
            oracle: [0; 32],
            total_assets: 0,
            lst_supply: 0,
            reserve_buffer: 0,
            pending_unstake_assets: 0,
            pending_unstake_count: 0,
            exchange_rate_bps: DEFAULT_EXCHANGE_RATE_BPS,
            cumulative_slashed: 0,
        })
    }

    fn read_state<T: BorshDeserialize>(account: &AccountInfo) -> Result<T, ProgramError> {
        T::try_from_slice(&account.try_borrow_data()?)
            .map_err(|_| LiquidStakingError::InvalidAccountData.into())
    }

    fn write_state<T: BorshSerialize>(
        account: &AccountInfo,
        state: &T,
    ) -> Result<(), ProgramError> {
        state
            .serialize(&mut &mut account.try_borrow_mut_data()?[..])
            .map_err(|_| LiquidStakingError::InvalidAccountData.into())
    }
}
