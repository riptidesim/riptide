//! `perpetuals` instruction processor.
//!
//! Mirrors the shape and style of `lending_pool::processor::Processor`
//! (explicit `require_signer`, explicit owner-asserts, explicit
//! Borsh read/write helpers, no CPI, no derived-address magic).
//!
//! Instruction dispatch: one Borsh-serialized `PerpsInstructionData`
//! variant per transaction. Callers (test harness and the engine)
//! construct bytes via `borsh::to_vec(&PerpsInstructionData::Variant {..})`
//! and pass `AccountInfo`s in the order documented on each variant.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    program_error::ProgramError,
    pubkey::Pubkey,
};

use crate::{
    error::PerpsError,
    state::{
        is_liquidatable, position_equity, MarketState, OracleView, PerpsInstructionData,
        PositionState, BPS_DENOMINATOR, MARKET_STATE_LEN, ORACLE_STATE_LEN, POSITION_STATE_LEN,
        SIDE_LONG, SIDE_SHORT,
    },
};

pub struct Processor;

impl Processor {
    pub fn process(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        instruction_data: &[u8],
    ) -> Result<(), ProgramError> {
        let instruction = PerpsInstructionData::try_from_slice(instruction_data)
            .map_err(|_| ProgramError::InvalidInstructionData)?;
        let accounts_iter = &mut accounts.iter();

        match instruction {
            PerpsInstructionData::InitializeMarket {
                max_leverage_bps,
                liquidation_threshold_bps,
            } => {
                let admin = next_account_info(accounts_iter)?;
                let market = next_account_info(accounts_iter)?;
                let oracle = next_account_info(accounts_iter)?;
                Self::require_signer(admin)?;
                Self::assert_program_account(market, program_id, MARKET_STATE_LEN)?;
                // `oracle` is owned by the oracle program, not perpetuals.
                // We validate the shape via Borsh read but do not enforce
                // `owner == program_id` — the oracle account is shared
                // across programs by design.
                Self::read_oracle(oracle)?;

                if max_leverage_bps == 0 || liquidation_threshold_bps == 0 {
                    return Err(PerpsError::InvalidAccountData.into());
                }

                let existing: MarketState = Self::read_state(market)?;
                if existing.is_initialized {
                    return Err(PerpsError::MarketAlreadyInitialized.into());
                }

                let state = MarketState {
                    is_initialized: true,
                    admin: admin.key.to_bytes(),
                    oracle: oracle.key.to_bytes(),
                    max_leverage_bps,
                    liquidation_threshold_bps,
                    total_oi_long: 0,
                    total_oi_short: 0,
                    total_collateral: 0,
                    cumulative_socialized_loss: 0,
                };
                Self::write_state(market, &state)
            }

            PerpsInstructionData::DepositCollateral { amount } => {
                let owner = next_account_info(accounts_iter)?;
                let market = next_account_info(accounts_iter)?;
                let position = next_account_info(accounts_iter)?;
                Self::require_signer(owner)?;
                Self::assert_program_account(market, program_id, MARKET_STATE_LEN)?;
                Self::assert_program_account(position, program_id, POSITION_STATE_LEN)?;

                if amount == 0 {
                    return Err(PerpsError::InsufficientCollateral.into());
                }

                let mut market_state: MarketState = Self::read_initialized_market(market)?;
                let mut position_state: PositionState = Self::read_state(position)?;

                if !position_state.is_initialized {
                    position_state.is_initialized = true;
                    position_state.owner = owner.key.to_bytes();
                    position_state.market = market.key.to_bytes();
                }
                if position_state.owner_pubkey() != *owner.key {
                    return Err(PerpsError::Unauthorized.into());
                }
                if position_state.market_pubkey() != *market.key {
                    return Err(PerpsError::Unauthorized.into());
                }
                if position_state.liquidated {
                    return Err(PerpsError::PositionLiquidated.into());
                }

                position_state.collateral = position_state
                    .collateral
                    .checked_add(amount)
                    .ok_or(PerpsError::MathOverflow)?;
                market_state.total_collateral = market_state
                    .total_collateral
                    .checked_add(amount)
                    .ok_or(PerpsError::MathOverflow)?;

                Self::write_state(market, &market_state)?;
                Self::write_state(position, &position_state)
            }

            PerpsInstructionData::WithdrawCollateral { amount } => {
                let owner = next_account_info(accounts_iter)?;
                let market = next_account_info(accounts_iter)?;
                let position = next_account_info(accounts_iter)?;
                Self::require_signer(owner)?;
                Self::assert_program_account(market, program_id, MARKET_STATE_LEN)?;
                Self::assert_program_account(position, program_id, POSITION_STATE_LEN)?;

                let mut market_state: MarketState = Self::read_initialized_market(market)?;
                let mut position_state: PositionState = Self::read_state(position)?;

                if !position_state.is_initialized {
                    return Err(PerpsError::InvalidAccountData.into());
                }
                if position_state.owner_pubkey() != *owner.key {
                    return Err(PerpsError::Unauthorized.into());
                }
                if position_state.market_pubkey() != *market.key {
                    return Err(PerpsError::Unauthorized.into());
                }
                // Perps-lite: no partial withdraws while a leg is open.
                if position_state.is_open() {
                    return Err(PerpsError::PositionAlreadyOpen.into());
                }
                if amount > position_state.collateral {
                    return Err(PerpsError::InsufficientCollateral.into());
                }

                position_state.collateral = position_state
                    .collateral
                    .checked_sub(amount)
                    .ok_or(PerpsError::MathOverflow)?;
                market_state.total_collateral = market_state
                    .total_collateral
                    .checked_sub(amount)
                    .ok_or(PerpsError::MathOverflow)?;

                Self::write_state(market, &market_state)?;
                Self::write_state(position, &position_state)
            }

            PerpsInstructionData::OpenPosition {
                side,
                leverage_bps,
                notional,
            } => {
                let owner = next_account_info(accounts_iter)?;
                let market = next_account_info(accounts_iter)?;
                let position = next_account_info(accounts_iter)?;
                let oracle = next_account_info(accounts_iter)?;
                Self::require_signer(owner)?;
                Self::assert_program_account(market, program_id, MARKET_STATE_LEN)?;
                Self::assert_program_account(position, program_id, POSITION_STATE_LEN)?;

                if side != SIDE_LONG && side != SIDE_SHORT {
                    return Err(PerpsError::InvalidSide.into());
                }
                if notional == 0 {
                    return Err(PerpsError::InvalidNotional.into());
                }

                let mut market_state: MarketState = Self::read_initialized_market(market)?;
                let oracle_state = Self::load_market_oracle(&market_state, oracle)?;
                let current_price = oracle_state.scaled_price()?;

                if leverage_bps == 0 || leverage_bps > market_state.max_leverage_bps {
                    return Err(PerpsError::LeverageTooHigh.into());
                }

                let mut position_state: PositionState = Self::read_state(position)?;
                if !position_state.is_initialized {
                    return Err(PerpsError::InvalidAccountData.into());
                }
                if position_state.owner_pubkey() != *owner.key {
                    return Err(PerpsError::Unauthorized.into());
                }
                if position_state.market_pubkey() != *market.key {
                    return Err(PerpsError::Unauthorized.into());
                }
                if position_state.liquidated {
                    return Err(PerpsError::PositionLiquidated.into());
                }
                if position_state.is_open() {
                    return Err(PerpsError::PositionAlreadyOpen.into());
                }

                // Required margin = notional / leverage. All bps math in u128
                // so a 1e9 notional at 1bps leverage does not overflow.
                let required_margin = (notional as u128)
                    .checked_mul(BPS_DENOMINATOR)
                    .ok_or(PerpsError::MathOverflow)?
                    .checked_div(leverage_bps as u128)
                    .ok_or(PerpsError::MathOverflow)?;
                if (position_state.collateral as u128) < required_margin {
                    return Err(PerpsError::InsufficientCollateral.into());
                }

                position_state.side = side;
                position_state.notional = notional;
                position_state.entry_price = current_price;
                position_state.leverage_bps = leverage_bps;

                match side {
                    SIDE_LONG => {
                        market_state.total_oi_long = market_state
                            .total_oi_long
                            .checked_add(notional)
                            .ok_or(PerpsError::MathOverflow)?;
                    }
                    SIDE_SHORT => {
                        market_state.total_oi_short = market_state
                            .total_oi_short
                            .checked_add(notional)
                            .ok_or(PerpsError::MathOverflow)?;
                    }
                    _ => return Err(PerpsError::InvalidSide.into()),
                }

                Self::write_state(market, &market_state)?;
                Self::write_state(position, &position_state)
            }

            PerpsInstructionData::ClosePosition => {
                let owner = next_account_info(accounts_iter)?;
                let market = next_account_info(accounts_iter)?;
                let position = next_account_info(accounts_iter)?;
                let oracle = next_account_info(accounts_iter)?;
                Self::require_signer(owner)?;
                Self::assert_program_account(market, program_id, MARKET_STATE_LEN)?;
                Self::assert_program_account(position, program_id, POSITION_STATE_LEN)?;

                let mut market_state: MarketState = Self::read_initialized_market(market)?;
                let oracle_state = Self::load_market_oracle(&market_state, oracle)?;
                let current_price = oracle_state.scaled_price()?;

                let mut position_state: PositionState = Self::read_state(position)?;
                if !position_state.is_initialized {
                    return Err(PerpsError::InvalidAccountData.into());
                }
                if position_state.owner_pubkey() != *owner.key {
                    return Err(PerpsError::Unauthorized.into());
                }
                if position_state.market_pubkey() != *market.key {
                    return Err(PerpsError::Unauthorized.into());
                }
                if !position_state.is_open() {
                    return Err(PerpsError::PositionNotOpen.into());
                }

                let equity = position_equity(&position_state, current_price)?;

                let old_notional = position_state.notional;
                let old_side = position_state.side;

                // Realize PnL into free collateral and clear the open leg.
                // `position_equity` clamps at 0 on the downside and
                // u64::MAX on the upside; the position absorbs PnL.
                position_state.collateral = equity;
                position_state.notional = 0;
                position_state.entry_price = 0;
                position_state.leverage_bps = 0;

                // Market-wide OI decreases by the closed notional.
                match old_side {
                    SIDE_LONG => {
                        market_state.total_oi_long =
                            market_state.total_oi_long.saturating_sub(old_notional);
                    }
                    SIDE_SHORT => {
                        market_state.total_oi_short =
                            market_state.total_oi_short.saturating_sub(old_notional);
                    }
                    _ => return Err(PerpsError::InvalidSide.into()),
                }

                // total_collateral is NOT adjusted on close. PnL changes
                // position.collateral (the free balance) but does not
                // create or destroy market-level value in perps-lite —
                // there is no real counterparty pool to debit/credit.
                // Conservation: total_collateral moves only on
                // deposit / withdraw / liquidate, giving a clean
                // closed-system invariant.

                Self::write_state(market, &market_state)?;
                Self::write_state(position, &position_state)
            }

            PerpsInstructionData::LiquidatePosition => {
                let liquidator = next_account_info(accounts_iter)?;
                let market = next_account_info(accounts_iter)?;
                let victim_position = next_account_info(accounts_iter)?;
                let oracle = next_account_info(accounts_iter)?;
                Self::require_signer(liquidator)?;
                Self::assert_program_account(market, program_id, MARKET_STATE_LEN)?;
                Self::assert_program_account(victim_position, program_id, POSITION_STATE_LEN)?;

                let mut market_state: MarketState = Self::read_initialized_market(market)?;
                let oracle_state = Self::load_market_oracle(&market_state, oracle)?;
                let current_price = oracle_state.scaled_price()?;

                let mut victim: PositionState = Self::read_state(victim_position)?;
                if !victim.is_initialized {
                    return Err(PerpsError::InvalidAccountData.into());
                }
                if victim.market_pubkey() != *market.key {
                    return Err(PerpsError::Unauthorized.into());
                }
                if !victim.is_open() {
                    return Err(PerpsError::PositionNotOpen.into());
                }
                if victim.liquidated {
                    return Err(PerpsError::PositionLiquidated.into());
                }

                let liquidatable = is_liquidatable(
                    &victim,
                    market_state.liquidation_threshold_bps,
                    current_price,
                )?;
                if !liquidatable {
                    return Err(PerpsError::PositionHealthy.into());
                }

                // Perps-lite: single-shot liquidation. Victim forfeits
                // *all* collateral; any loss beyond that is shortfall that
                // the market socializes.
                //
                // Raw loss is computed WITHOUT position_equity's zero-clamp
                // — we need the unclamped figure to detect shortfall (loss
                // that exceeds the posted margin). position_equity clamps
                // at zero so `collateral - position_equity(…)` can never
                // exceed collateral, which was the bug.
                let raw_loss: u64 = {
                    let entry = victim.entry_price as u128;
                    let cur = current_price as u128;
                    let notional = victim.notional as u128;
                    if entry == 0 {
                        0
                    } else {
                        let loss = match victim.side {
                            SIDE_LONG if cur < entry => {
                                notional
                                    .checked_mul(entry - cur)
                                    .unwrap_or(u128::MAX)
                                    / entry
                            }
                            SIDE_SHORT if cur > entry => {
                                notional
                                    .checked_mul(cur - entry)
                                    .unwrap_or(u128::MAX)
                                    / entry
                            }
                            _ => 0,
                        };
                        loss.min(u64::MAX as u128) as u64
                    }
                };
                let shortfall = raw_loss.saturating_sub(victim.collateral);

                let victim_notional = victim.notional;
                let victim_side = victim.side;
                let victim_collateral_seized = victim.collateral;

                victim.collateral = 0;
                victim.notional = 0;
                victim.entry_price = 0;
                victim.leverage_bps = 0;
                victim.liquidated = true;

                match victim_side {
                    SIDE_LONG => {
                        market_state.total_oi_long =
                            market_state.total_oi_long.saturating_sub(victim_notional);
                    }
                    SIDE_SHORT => {
                        market_state.total_oi_short =
                            market_state.total_oi_short.saturating_sub(victim_notional);
                    }
                    _ => return Err(PerpsError::InvalidSide.into()),
                }
                market_state.total_collateral = market_state
                    .total_collateral
                    .saturating_sub(victim_collateral_seized);
                market_state.cumulative_socialized_loss = market_state
                    .cumulative_socialized_loss
                    .checked_add(shortfall)
                    .ok_or(PerpsError::MathOverflow)?;

                Self::write_state(market, &market_state)?;
                Self::write_state(victim_position, &victim)
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
            return Err(PerpsError::InvalidAccountOwner.into());
        }
        if account.data_len() < expected_len {
            return Err(PerpsError::InvalidAccountData.into());
        }
        Ok(())
    }

    /// Read and lazy-initialize a market account.
    ///
    /// **Generic-harness compatibility:** the engine's `GenericHarness`
    /// bootstraps program-owned accounts by allocating zero-byte
    /// buffers (see `engine/src/primitive/generic.rs :: bootstrap_generic_accounts`).
    /// Perps-fork's deposit/withdraw instructions need a market to
    /// read from, so if the market bytes are still all zero we treat
    /// that as a first-touch lazy init with sane defaults (10x
    /// leverage cap, 5% maintenance margin). `initialize_market`
    /// still works for explicit setup — it writes the admin and
    /// oracle pubkeys and runs against the same zero-read fast path.
    /// The lazy path does NOT pin an admin (admin stays zeroed);
    /// every caller signer is effectively trusted, which is fine for
    /// a simulation harness and deliberately NOT production-safe.
    fn read_initialized_market(
        account: &AccountInfo,
    ) -> Result<MarketState, ProgramError> {
        let market: MarketState = Self::read_state(account)?;
        if market.is_initialized {
            return Ok(market);
        }
        Ok(MarketState {
            is_initialized: true,
            admin: [0; 32],
            oracle: [0; 32],
            max_leverage_bps: 100_000,
            liquidation_threshold_bps: 500,
            total_oi_long: 0,
            total_oi_short: 0,
            total_collateral: 0,
            cumulative_socialized_loss: 0,
        })
    }

    /// Read an admin-mock oracle account into an `OracleView`. Does NOT
    /// enforce ownership — the oracle account is owned by its own
    /// program (admin_mock_oracle), not perpetuals. Layout compatibility
    /// is enforced by the data length check and the Borsh deserializer.
    fn read_oracle(account: &AccountInfo) -> Result<OracleView, ProgramError> {
        if account.data_len() < ORACLE_STATE_LEN {
            return Err(PerpsError::UninitializedOracle.into());
        }
        let data = account.try_borrow_data()?;
        let view = OracleView::try_from_slice(&data[..ORACLE_STATE_LEN])
            .map_err(|_| PerpsError::InvalidAccountData)?;
        if !view.is_initialized {
            return Err(PerpsError::UninitializedOracle.into());
        }
        Ok(view)
    }

    /// Cross-check that the oracle the caller passed matches the one
    /// stored on the market at `initialize_market` time, then read it.
    fn load_market_oracle(
        market_state: &MarketState,
        oracle_account: &AccountInfo,
    ) -> Result<OracleView, ProgramError> {
        if market_state.oracle_pubkey() != *oracle_account.key {
            return Err(PerpsError::OracleMismatch.into());
        }
        Self::read_oracle(oracle_account)
    }

    fn read_state<T: BorshDeserialize>(
        account: &AccountInfo,
    ) -> Result<T, ProgramError> {
        T::try_from_slice(&account.try_borrow_data()?)
            .map_err(|_| PerpsError::InvalidAccountData.into())
    }

    fn write_state<T: BorshSerialize>(
        account: &AccountInfo,
        state: &T,
    ) -> Result<(), ProgramError> {
        state
            .serialize(&mut &mut account.try_borrow_mut_data()?[..])
            .map_err(|_| PerpsError::InvalidAccountData.into())
    }
}
