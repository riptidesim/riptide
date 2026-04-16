//! T17 — Perps-fork LiteSVM round-trip (Sprint 5 Phase 2 · T07 gate).
//!
//! End-to-end coverage that the shipped `perps-fork.so` loads in
//! LiteSVM and exercises every surviving instruction of the perps-lite
//! scope (init_market, deposit/withdraw_collateral, open/close_position,
//! liquidate_position) against the real `admin_mock_oracle.so` oracle.
//!
//! Scope cuts (documented in the T07 task note):
//! - No `update_funding_rate` — funding rate is a Sprint 6 follow-up.
//!   The shipping `perps-fork.toml` leaves `[[scheduled_actions]]`
//!   empty so the engine's scheduled-action dispatch goes through
//!   `Primitive::on_scheduled_action`'s default no-op hook.
//! - No insurance fund. Losses beyond posted margin land in
//!   `MarketState.cumulative_socialized_loss`.
//!
//! Three tests:
//! 1. `perps_fork_roundtrip_long_path` — init → deposit → open (long)
//!    → close on flat oracle → withdraw. Asserts PnL is ~0, collateral
//!    round-trips, OI returns to zero.
//! 2. `perps_fork_liquidation_cascade` — init → deposit → open (long, 5x)
//!    → oracle shock → liquidate → inspect cumulative_socialized_loss.
//! 3. `perps_fork_is_deterministic` — two fresh instances replay the
//!    long path and produce byte-identical final market+position state.
//!
//! All three tests are gated on both `.so` artifacts existing; a
//! missing `.so` prints a skip message (same pattern as t18's
//! `admin_mock_oracle_roundtrip_through_dispatch`).

#![cfg(feature = "litesvm-backend")]

use std::path::{Path, PathBuf};

use borsh::{BorshDeserialize, BorshSerialize};
use litesvm::LiteSVM;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
};
use solana_system_interface::instruction as system_instruction;
use solana_transaction::Transaction;

// --- Byte-level constants mirrored from `programs/perps-fork/src/state.rs` ---

const MARKET_STATE_LEN: usize = 1 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8; // 113
const POSITION_STATE_LEN: usize = 1 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 1; // 106
const ORACLE_STATE_LEN: usize = 50;

const SIDE_LONG: u64 = 0;
#[allow(dead_code)]
const SIDE_SHORT: u64 = 1;

// --- Borsh mirrors of the on-chain instruction enums ---
//
// Mirrored locally so the test does not need to depend on the on-chain
// crates from the engine workspace (same pattern t18 uses for
// `admin_mock_oracle::OracleInstructionData`).

#[derive(BorshSerialize)]
enum PerpsIx {
    InitializeMarket {
        max_leverage_bps: u64,
        liquidation_threshold_bps: u64,
    },
    DepositCollateral {
        amount: u64,
    },
    WithdrawCollateral {
        amount: u64,
    },
    OpenPosition {
        side: u64,
        leverage_bps: u64,
        notional: u64,
    },
    ClosePosition,
    LiquidatePosition,
}

#[derive(BorshSerialize)]
enum OracleIx {
    InitializeOracle { price: u64, exponent: i8 },
    SetPrice { price: u64, exponent: i8 },
}

#[derive(BorshDeserialize, Debug, PartialEq, Eq)]
struct MarketState {
    is_initialized: bool,
    admin: [u8; 32],
    oracle: [u8; 32],
    max_leverage_bps: u64,
    liquidation_threshold_bps: u64,
    total_oi_long: u64,
    total_oi_short: u64,
    total_collateral: u64,
    cumulative_socialized_loss: u64,
}

#[derive(BorshDeserialize, Debug, PartialEq, Eq)]
struct PositionState {
    is_initialized: bool,
    owner: [u8; 32],
    market: [u8; 32],
    side: u64,
    collateral: u64,
    notional: u64,
    entry_price: u64,
    leverage_bps: u64,
    liquidated: bool,
}

// --- Path helpers + skip gate ---

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("engine crate has a parent")
        .to_path_buf()
}

fn perps_so_path() -> PathBuf {
    workspace_root().join("programs/perps-fork/target/deploy/perps_fork.so")
}

fn oracle_so_path() -> PathBuf {
    workspace_root().join("programs/admin_mock_oracle/target/deploy/admin_mock_oracle.so")
}

fn skip_if_missing(paths: &[&Path]) -> bool {
    for p in paths {
        if !p.exists() {
            eprintln!(
                "skipping t17 perps-fork LiteSVM test: {} missing \
                 (build both with \
                 `cargo build-sbf --manifest-path programs/perps-fork/Cargo.toml` and \
                 `cargo build-sbf --manifest-path programs/admin_mock_oracle/Cargo.toml`)",
                p.display()
            );
            return true;
        }
    }
    false
}

// --- Bootstrap + helpers ---

struct PerpsHarness {
    svm: LiteSVM,
    perps_program_id: Pubkey,
    oracle_program_id: Pubkey,
    admin: Keypair,
    market: Keypair,
    oracle: Keypair,
    trader: Keypair,
    position: Keypair,
}

impl PerpsHarness {
    fn new() -> Self {
        let mut svm = LiteSVM::new().with_builtins().with_sysvars();

        let perps_program_id = Pubkey::new_unique();
        let oracle_program_id = Pubkey::new_unique();

        svm.add_program(perps_program_id, &std::fs::read(perps_so_path()).unwrap())
            .expect("load perps_fork.so");
        svm.add_program(
            oracle_program_id,
            &std::fs::read(oracle_so_path()).unwrap(),
        )
        .expect("load admin_mock_oracle.so");

        let admin = Keypair::new();
        let trader = Keypair::new();
        svm.airdrop(&admin.pubkey(), 500_000_000_000).unwrap();
        svm.airdrop(&trader.pubkey(), 500_000_000_000).unwrap();

        let market = Keypair::new();
        let oracle = Keypair::new();
        let position = Keypair::new();

        Self {
            svm,
            perps_program_id,
            oracle_program_id,
            admin,
            market,
            oracle,
            trader,
            position,
        }
    }

    fn send(&mut self, ix: Instruction, signer: &Keypair, extras: &[&Keypair]) {
        let blockhash = self.svm.latest_blockhash();
        let mut signers: Vec<&Keypair> = vec![signer];
        for s in extras {
            if s.pubkey() != signer.pubkey() {
                signers.push(s);
            }
        }
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&signer.pubkey()),
            &signers,
            blockhash,
        );
        self.svm
            .send_transaction(tx)
            .unwrap_or_else(|e| panic!("send_transaction failed: {:?}", e.err));
    }

    fn send_expect_fail(&mut self, ix: Instruction, signer: &Keypair, extras: &[&Keypair]) {
        let blockhash = self.svm.latest_blockhash();
        let mut signers: Vec<&Keypair> = vec![signer];
        for s in extras {
            if s.pubkey() != signer.pubkey() {
                signers.push(s);
            }
        }
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&signer.pubkey()),
            &signers,
            blockhash,
        );
        assert!(
            self.svm.send_transaction(tx).is_err(),
            "expected send_transaction to fail"
        );
    }

    fn create_and_own(
        &mut self,
        payer: &Keypair,
        target: &Keypair,
        space: usize,
        owner: &Pubkey,
    ) {
        let rent = self.svm.minimum_balance_for_rent_exemption(space);
        let ix = system_instruction::create_account(
            &payer.pubkey(),
            &target.pubkey(),
            rent,
            space as u64,
            owner,
        );
        self.send(ix, payer, &[target]);
    }

    fn initialize_oracle(&mut self, price: u64) {
        let admin_kp = self.admin.insecure_clone();
        let oracle_kp = self.oracle.insecure_clone();
        let oracle_program_id = self.oracle_program_id;
        self.create_and_own(&admin_kp, &oracle_kp, ORACLE_STATE_LEN, &oracle_program_id);
        let data = OracleIx::InitializeOracle { price, exponent: 0 };
        let ix = Instruction::new_with_borsh(
            self.oracle_program_id,
            &data,
            vec![
                AccountMeta::new(self.oracle.pubkey(), false),
                AccountMeta::new_readonly(self.admin.pubkey(), true),
            ],
        );
        let admin_kp = self.admin.insecure_clone();
        self.send(ix, &admin_kp, &[]);
    }

    fn set_oracle_price(&mut self, price: u64) {
        let data = OracleIx::SetPrice { price, exponent: 0 };
        let ix = Instruction::new_with_borsh(
            self.oracle_program_id,
            &data,
            vec![
                AccountMeta::new(self.oracle.pubkey(), false),
                AccountMeta::new_readonly(self.admin.pubkey(), true),
            ],
        );
        let admin_kp = self.admin.insecure_clone();
        self.send(ix, &admin_kp, &[]);
    }

    fn initialize_market(&mut self, max_leverage_bps: u64, liquidation_threshold_bps: u64) {
        let admin_kp = self.admin.insecure_clone();
        let market_kp = self.market.insecure_clone();
        let perps_program_id = self.perps_program_id;
        self.create_and_own(&admin_kp, &market_kp, MARKET_STATE_LEN, &perps_program_id);
        let data = PerpsIx::InitializeMarket {
            max_leverage_bps,
            liquidation_threshold_bps,
        };
        let ix = Instruction::new_with_borsh(
            self.perps_program_id,
            &data,
            vec![
                AccountMeta::new_readonly(self.admin.pubkey(), true),
                AccountMeta::new(self.market.pubkey(), false),
                AccountMeta::new_readonly(self.oracle.pubkey(), false),
            ],
        );
        let admin_kp = self.admin.insecure_clone();
        self.send(ix, &admin_kp, &[]);
    }

    fn create_position_account(&mut self) {
        let trader_kp = self.trader.insecure_clone();
        let position_kp = self.position.insecure_clone();
        let perps_program_id = self.perps_program_id;
        self.create_and_own(&trader_kp, &position_kp, POSITION_STATE_LEN, &perps_program_id);
    }

    fn deposit(&mut self, amount: u64) {
        let data = PerpsIx::DepositCollateral { amount };
        let ix = Instruction::new_with_borsh(
            self.perps_program_id,
            &data,
            vec![
                AccountMeta::new_readonly(self.trader.pubkey(), true),
                AccountMeta::new(self.market.pubkey(), false),
                AccountMeta::new(self.position.pubkey(), false),
            ],
        );
        let trader_kp = self.trader.insecure_clone();
        self.send(ix, &trader_kp, &[]);
    }

    fn withdraw(&mut self, amount: u64) {
        let data = PerpsIx::WithdrawCollateral { amount };
        let ix = Instruction::new_with_borsh(
            self.perps_program_id,
            &data,
            vec![
                AccountMeta::new_readonly(self.trader.pubkey(), true),
                AccountMeta::new(self.market.pubkey(), false),
                AccountMeta::new(self.position.pubkey(), false),
            ],
        );
        let trader_kp = self.trader.insecure_clone();
        self.send(ix, &trader_kp, &[]);
    }

    fn open_position(&mut self, side: u64, leverage_bps: u64, notional: u64) {
        let data = PerpsIx::OpenPosition {
            side,
            leverage_bps,
            notional,
        };
        let ix = Instruction::new_with_borsh(
            self.perps_program_id,
            &data,
            vec![
                AccountMeta::new_readonly(self.trader.pubkey(), true),
                AccountMeta::new(self.market.pubkey(), false),
                AccountMeta::new(self.position.pubkey(), false),
                AccountMeta::new_readonly(self.oracle.pubkey(), false),
            ],
        );
        let trader_kp = self.trader.insecure_clone();
        self.send(ix, &trader_kp, &[]);
    }

    fn close_position(&mut self) {
        let data = PerpsIx::ClosePosition;
        let ix = Instruction::new_with_borsh(
            self.perps_program_id,
            &data,
            vec![
                AccountMeta::new_readonly(self.trader.pubkey(), true),
                AccountMeta::new(self.market.pubkey(), false),
                AccountMeta::new(self.position.pubkey(), false),
                AccountMeta::new_readonly(self.oracle.pubkey(), false),
            ],
        );
        let trader_kp = self.trader.insecure_clone();
        self.send(ix, &trader_kp, &[]);
    }

    fn liquidate(&mut self, liquidator: &Keypair) {
        let data = PerpsIx::LiquidatePosition;
        let ix = Instruction::new_with_borsh(
            self.perps_program_id,
            &data,
            vec![
                AccountMeta::new_readonly(liquidator.pubkey(), true),
                AccountMeta::new(self.market.pubkey(), false),
                AccountMeta::new(self.position.pubkey(), false),
                AccountMeta::new_readonly(self.oracle.pubkey(), false),
            ],
        );
        self.send(ix, liquidator, &[]);
    }

    fn read_market(&self) -> MarketState {
        let acc = self.svm.get_account(&self.market.pubkey()).unwrap();
        MarketState::try_from_slice(&acc.data[..MARKET_STATE_LEN])
            .expect("decode market state")
    }

    fn read_position(&self) -> PositionState {
        let acc = self.svm.get_account(&self.position.pubkey()).unwrap();
        PositionState::try_from_slice(&acc.data[..POSITION_STATE_LEN])
            .expect("decode position state")
    }

}

// --- Tests ---

#[test]
fn perps_fork_roundtrip_long_path() {
    if skip_if_missing(&[&perps_so_path(), &oracle_so_path()]) {
        return;
    }
    let mut h = PerpsHarness::new();
    h.initialize_oracle(100);
    h.initialize_market(100_000 /* 10x */, 500 /* 5% maintenance */);
    h.create_position_account();

    h.deposit(1_000);
    let after_deposit = h.read_position();
    assert_eq!(after_deposit.collateral, 1_000);
    assert!(after_deposit.is_initialized);
    assert_eq!(after_deposit.notional, 0);

    // 5x long on 5_000 notional. Required margin = 5_000 * 10_000 / 50_000 = 1_000.
    h.open_position(SIDE_LONG, 50_000, 5_000);
    let opened = h.read_position();
    assert_eq!(opened.notional, 5_000);
    assert_eq!(opened.entry_price, 100);
    assert_eq!(opened.side, SIDE_LONG);
    assert_eq!(opened.leverage_bps, 50_000);
    let market_opened = h.read_market();
    assert_eq!(market_opened.total_oi_long, 5_000);
    assert_eq!(market_opened.total_oi_short, 0);

    // Close on flat oracle — PnL is zero, collateral unchanged.
    h.close_position();
    let closed = h.read_position();
    assert_eq!(closed.collateral, 1_000);
    assert_eq!(closed.notional, 0);
    assert_eq!(closed.entry_price, 0);
    let market_closed = h.read_market();
    assert_eq!(market_closed.total_oi_long, 0);

    // Round-trip withdrawal puts collateral back to zero.
    h.withdraw(1_000);
    let withdrawn = h.read_position();
    assert_eq!(withdrawn.collateral, 0);
    assert_eq!(h.read_market().total_collateral, 0);
}

#[test]
fn perps_fork_liquidation_cascade() {
    if skip_if_missing(&[&perps_so_path(), &oracle_so_path()]) {
        return;
    }
    let mut h = PerpsHarness::new();
    h.initialize_oracle(100);
    h.initialize_market(100_000 /* 10x cap */, 500 /* 5% maint */);
    h.create_position_account();

    h.deposit(1_000);
    // 10x long on 10_000 notional — fully leveraged against the 1_000 margin.
    h.open_position(SIDE_LONG, 100_000, 10_000);
    assert_eq!(h.read_market().total_oi_long, 10_000);

    // Oracle shock: price drops 40% (Sprint 4 hero-grid w25-s40 magnitude).
    h.set_oracle_price(60);

    // A liquidator not owning the position can call liquidate_position.
    let liquidator = Keypair::new();
    h.svm.airdrop(&liquidator.pubkey(), 100_000_000_000).unwrap();
    h.liquidate(&liquidator);

    let liq = h.read_position();
    assert!(liq.liquidated);
    assert_eq!(liq.collateral, 0);
    assert_eq!(liq.notional, 0);

    let market_after = h.read_market();
    assert_eq!(market_after.total_oi_long, 0);
    assert_eq!(market_after.total_collateral, 0);
    // Loss = notional * (100 - 60) / 100 = 10_000 * 40 / 100 = 4_000.
    // Posted margin = 1_000.
    // Shortfall = raw_loss - collateral = 4_000 - 1_000 = 3_000.
    assert_eq!(market_after.cumulative_socialized_loss, 3_000);
}

#[test]
fn perps_fork_is_deterministic() {
    if skip_if_missing(&[&perps_so_path(), &oracle_so_path()]) {
        return;
    }

    // The per-replay admin/oracle/trader/position keypairs are generated
    // randomly by `Keypair::new()` so the 32-byte identity fields of the
    // on-chain state legitimately differ between replays. Determinism is
    // about *protocol-state* byte stability: same seed, same inputs →
    // identical OI, collateral, loss, leverage config, PnL math. Extract
    // the non-identity fields of Market + Position and assert those.
    fn replay() -> (MarketState, PositionState) {
        let mut h = PerpsHarness::new();
        h.initialize_oracle(100);
        h.initialize_market(100_000, 500);
        h.create_position_account();
        h.deposit(1_000);
        h.open_position(SIDE_LONG, 50_000, 5_000);
        h.close_position();
        (h.read_market(), h.read_position())
    }

    let (m1, p1) = replay();
    let (m2, p2) = replay();
    // Compare everything *except* the pubkey identity fields.
    assert_eq!(m1.is_initialized, m2.is_initialized);
    assert_eq!(m1.max_leverage_bps, m2.max_leverage_bps);
    assert_eq!(m1.liquidation_threshold_bps, m2.liquidation_threshold_bps);
    assert_eq!(m1.total_oi_long, m2.total_oi_long);
    assert_eq!(m1.total_oi_short, m2.total_oi_short);
    assert_eq!(m1.total_collateral, m2.total_collateral);
    assert_eq!(
        m1.cumulative_socialized_loss,
        m2.cumulative_socialized_loss
    );
    assert_eq!(p1.is_initialized, p2.is_initialized);
    assert_eq!(p1.side, p2.side);
    assert_eq!(p1.collateral, p2.collateral);
    assert_eq!(p1.notional, p2.notional);
    assert_eq!(p1.entry_price, p2.entry_price);
    assert_eq!(p1.leverage_bps, p2.leverage_bps);
    assert_eq!(p1.liquidated, p2.liquidated);
}

#[test]
fn perps_fork_rejects_leverage_over_cap() {
    if skip_if_missing(&[&perps_so_path(), &oracle_so_path()]) {
        return;
    }
    let mut h = PerpsHarness::new();
    h.initialize_oracle(100);
    h.initialize_market(100_000, 500);
    h.create_position_account();
    h.deposit(10_000);
    // leverage_bps 200_000 (20x) exceeds the 10x cap — expect rejection.
    let data = PerpsIx::OpenPosition {
        side: SIDE_LONG,
        leverage_bps: 200_000,
        notional: 5_000,
    };
    let ix = Instruction::new_with_borsh(
        h.perps_program_id,
        &data,
        vec![
            AccountMeta::new_readonly(h.trader.pubkey(), true),
            AccountMeta::new(h.market.pubkey(), false),
            AccountMeta::new(h.position.pubkey(), false),
            AccountMeta::new_readonly(h.oracle.pubkey(), false),
        ],
    );
    let trader_kp = h.trader.insecure_clone();
    h.send_expect_fail(ix, &trader_kp, &[]);
}

#[test]
fn perps_fork_rejects_cross_market_liquidation() {
    if skip_if_missing(&[&perps_so_path(), &oracle_so_path()]) {
        return;
    }
    let mut h = PerpsHarness::new();
    h.initialize_oracle(100);
    h.initialize_market(100_000, 500);
    h.create_position_account();
    h.deposit(1_000);
    h.open_position(SIDE_LONG, 100_000, 10_000);

    // Oracle shock so the position is genuinely liquidatable against
    // its own market.
    h.set_oracle_price(60);

    // Create a second market with a different keypair, still owned by
    // the same perps program.
    let market2 = Keypair::new();
    let perps_program_id = h.perps_program_id;
    let admin_kp = h.admin.insecure_clone();
    h.create_and_own(&admin_kp, &market2, MARKET_STATE_LEN, &perps_program_id);
    let init_data = PerpsIx::InitializeMarket {
        max_leverage_bps: 100_000,
        liquidation_threshold_bps: 500,
    };
    let init_ix = Instruction::new_with_borsh(
        h.perps_program_id,
        &init_data,
        vec![
            AccountMeta::new_readonly(h.admin.pubkey(), true),
            AccountMeta::new(market2.pubkey(), false),
            AccountMeta::new_readonly(h.oracle.pubkey(), false),
        ],
    );
    let admin_kp2 = h.admin.insecure_clone();
    h.send(init_ix, &admin_kp2, &[]);

    // Attempt to liquidate the position using market2 — the position
    // belongs to market1, so the cross-check must reject.
    let liquidator = Keypair::new();
    h.svm.airdrop(&liquidator.pubkey(), 100_000_000_000).unwrap();
    let liq_data = PerpsIx::LiquidatePosition;
    let liq_ix = Instruction::new_with_borsh(
        h.perps_program_id,
        &liq_data,
        vec![
            AccountMeta::new_readonly(liquidator.pubkey(), true),
            AccountMeta::new(market2.pubkey(), false),
            AccountMeta::new(h.position.pubkey(), false),
            AccountMeta::new_readonly(h.oracle.pubkey(), false),
        ],
    );
    h.send_expect_fail(liq_ix, &liquidator, &[]);

    // Confirm the position is still open (not liquidated).
    let pos = h.read_position();
    assert!(!pos.liquidated);
    assert_eq!(pos.notional, 10_000);
}
