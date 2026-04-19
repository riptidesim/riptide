//! AMM-fork LiteSVM round-trip ( · gate).
//!
//! End-to-end coverage that the shipped `amm_fork.so` loads in LiteSVM
//! and exercises every instruction of the AMM-lite scope:
//! `initialize_pool → add_liquidity → swap → remove_liquidity`.
//!
//! Scope cuts (documented in the task note):
//! - No real SPL token transfers — reserves are virtual u64 counters.
//! - No LP mint — LP shares are per-agent counters on `LpPositionState`.
//! - No oracle — price derives from reserves; `adapter.toml` has no
//! `[[oracles]]` block, which is load-bearing for the story.
//!
//! Four tests:
//! 1. `amm_fork_roundtrip_full_path` — init → add → swap → read reserves →
//! remove. Asserts reserves update under constant-product, LP supply
//! round-trips, cumulative volume + fees accrue.
//! 2. `amm_fork_constant_product_holds_within_tolerance` — fires 5 swaps
//! in alternating directions on a no-fee pool and asserts the
//! product `reserve_a * reserve_b` stays within integer-math rounding
//! tolerance of its initial value. (Proves the swap math respects the
//! invariant up to per-swap truncation.)
//! 3. `amm_fork_rejects_slippage` — swap with `min_amount_out` above the
//! achievable output must reject with `SlippageExceeded`.
//! 4. `amm_fork_is_deterministic` — two fresh instances replay the full
//! path and produce byte-identical final pool state on every non-
//! identity field.
//!
//! All four tests are gated on the `.so` artifact existing; a missing
//! `.so` prints a skip message (same pattern as t17's
//! `perps_fork_roundtrip_long_path`).

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

// --- Byte-level constants mirrored from `programs/amm-fork/src/state.rs` ---

const POOL_STATE_LEN: usize =
    1 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 8 + 8; // 161
const LP_POSITION_STATE_LEN: usize = 1 + 32 + 32 + 8; // 73

const DIRECTION_A_TO_B: u64 = 0;
const DIRECTION_B_TO_A: u64 = 1;

// --- Borsh mirror of the on-chain instruction enum ---
//
// Mirrored locally so the test does not need to depend on the on-chain
// crate from the engine workspace (same pattern t17 uses for
// `perps_fork::state::PerpsInstructionData`).
#[derive(BorshSerialize)]
enum AmmIx {
    InitializePool {
        initial_a: u64,
        initial_b: u64,
        fee_bps: u64,
    },
    AddLiquidity {
        amount_a: u64,
        amount_b: u64,
    },
    RemoveLiquidity {
        shares: u64,
    },
    Swap {
        amount_in: u64,
        min_amount_out: u64,
        direction: u64,
    },
}

#[derive(BorshDeserialize, Debug, PartialEq, Eq)]
struct PoolState {
    is_initialized: bool,
    admin: [u8; 32],
    token_a_mint: [u8; 32],
    token_b_mint: [u8; 32],
    reserve_a: u64,
    reserve_b: u64,
    total_lp_supply: u64,
    last_swap_price: u64,
    cumulative_volume: u64,
    cumulative_fees: u64,
    fee_bps: u64,
    k_last: u64,
}

#[derive(BorshDeserialize, Debug, PartialEq, Eq)]
struct LpPositionState {
    is_initialized: bool,
    owner: [u8; 32],
    pool: [u8; 32],
    lp_shares: u64,
}

// --- Path helpers + skip gate ---

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("engine crate has a parent")
        .to_path_buf()
}

fn amm_so_path() -> PathBuf {
    workspace_root().join("programs/amm-fork/target/deploy/amm_fork.so")
}

fn skip_if_missing(paths: &[&Path]) -> bool {
    for p in paths {
        if !p.exists() {
            eprintln!(
                "skipping t24 amm-fork LiteSVM test: {} missing \
                 (build with \
                 `cargo build-sbf --manifest-path programs/amm-fork/Cargo.toml`)",
                p.display()
            );
            return true;
        }
    }
    false
}

// --- Bootstrap + helpers ---

struct AmmHarness {
    svm: LiteSVM,
    program_id: Pubkey,
    admin: Keypair,
    pool: Keypair,
    admin_position: Keypair,
    trader: Keypair,
    lp: Keypair,
    lp_position: Keypair,
}

impl AmmHarness {
    fn new() -> Self {
        let mut svm = LiteSVM::new().with_builtins().with_sysvars();

        let program_id = Pubkey::new_unique();
        svm.add_program(program_id, &std::fs::read(amm_so_path()).unwrap())
            .expect("load amm_fork.so");

        let admin = Keypair::new();
        let trader = Keypair::new();
        let lp = Keypair::new();
        svm.airdrop(&admin.pubkey(), 500_000_000_000).unwrap();
        svm.airdrop(&trader.pubkey(), 500_000_000_000).unwrap();
        svm.airdrop(&lp.pubkey(), 500_000_000_000).unwrap();

        Self {
            svm,
            program_id,
            admin,
            pool: Keypair::new(),
            admin_position: Keypair::new(),
            trader,
            lp,
            lp_position: Keypair::new(),
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

    fn initialize_pool(&mut self, initial_a: u64, initial_b: u64, fee_bps: u64) {
        let admin_kp = self.admin.insecure_clone();
        let pool_kp = self.pool.insecure_clone();
        let admin_position_kp = self.admin_position.insecure_clone();
        let program_id = self.program_id;
        self.create_and_own(&admin_kp, &pool_kp, POOL_STATE_LEN, &program_id);
        self.create_and_own(
            &admin_kp,
            &admin_position_kp,
            LP_POSITION_STATE_LEN,
            &program_id,
        );

        let data = AmmIx::InitializePool {
            initial_a,
            initial_b,
            fee_bps,
        };
        let ix = Instruction::new_with_borsh(
            self.program_id,
            &data,
            vec![
                AccountMeta::new_readonly(self.admin.pubkey(), true),
                AccountMeta::new(self.pool.pubkey(), false),
                AccountMeta::new(self.admin_position.pubkey(), false),
            ],
        );
        let admin_kp = self.admin.insecure_clone();
        self.send(ix, &admin_kp, &[]);
    }

    fn create_lp_position(&mut self) {
        let lp_kp = self.lp.insecure_clone();
        let lp_position_kp = self.lp_position.insecure_clone();
        let program_id = self.program_id;
        self.create_and_own(&lp_kp, &lp_position_kp, LP_POSITION_STATE_LEN, &program_id);
    }

    fn add_liquidity(&mut self, amount_a: u64, amount_b: u64) {
        let data = AmmIx::AddLiquidity { amount_a, amount_b };
        let ix = Instruction::new_with_borsh(
            self.program_id,
            &data,
            vec![
                AccountMeta::new_readonly(self.lp.pubkey(), true),
                AccountMeta::new(self.pool.pubkey(), false),
                AccountMeta::new(self.lp_position.pubkey(), false),
            ],
        );
        let lp_kp = self.lp.insecure_clone();
        self.send(ix, &lp_kp, &[]);
    }

    fn remove_liquidity(&mut self, shares: u64) {
        let data = AmmIx::RemoveLiquidity { shares };
        let ix = Instruction::new_with_borsh(
            self.program_id,
            &data,
            vec![
                AccountMeta::new_readonly(self.lp.pubkey(), true),
                AccountMeta::new(self.pool.pubkey(), false),
                AccountMeta::new(self.lp_position.pubkey(), false),
            ],
        );
        let lp_kp = self.lp.insecure_clone();
        self.send(ix, &lp_kp, &[]);
    }

    fn swap(&mut self, amount_in: u64, min_amount_out: u64, direction: u64) {
        let data = AmmIx::Swap {
            amount_in,
            min_amount_out,
            direction,
        };
        let ix = Instruction::new_with_borsh(
            self.program_id,
            &data,
            vec![
                AccountMeta::new_readonly(self.trader.pubkey(), true),
                AccountMeta::new(self.pool.pubkey(), false),
            ],
        );
        let trader_kp = self.trader.insecure_clone();
        self.send(ix, &trader_kp, &[]);
    }

    fn read_pool(&self) -> PoolState {
        let acc = self.svm.get_account(&self.pool.pubkey()).unwrap();
        PoolState::try_from_slice(&acc.data[..POOL_STATE_LEN]).expect("decode pool state")
    }

    fn read_lp_position(&self) -> LpPositionState {
        let acc = self.svm.get_account(&self.lp_position.pubkey()).unwrap();
        LpPositionState::try_from_slice(&acc.data[..LP_POSITION_STATE_LEN])
            .expect("decode lp position state")
    }
}

// --- Tests ---

#[test]
fn amm_fork_roundtrip_full_path() {
    if skip_if_missing(&[&amm_so_path()]) {
        return;
    }
    let mut h = AmmHarness::new();
    h.initialize_pool(1_000_000, 1_000_000, 30);
    let after_init = h.read_pool();
    assert!(after_init.is_initialized);
    assert_eq!(after_init.reserve_a, 1_000_000);
    assert_eq!(after_init.reserve_b, 1_000_000);
    assert_eq!(after_init.total_lp_supply, 2_000_000);
    assert_eq!(after_init.fee_bps, 30);
    assert_eq!(after_init.k_last, 1_000_000 * 1_000_000);

    h.create_lp_position();
    h.add_liquidity(100_000, 100_000);
    let after_add = h.read_pool();
    assert_eq!(after_add.reserve_a, 1_100_000);
    assert_eq!(after_add.reserve_b, 1_100_000);
    // Shares minted = 100_000 * 2_000_000 / 1_000_000 = 200_000.
    assert_eq!(after_add.total_lp_supply, 2_200_000);
    assert_eq!(h.read_lp_position().lp_shares, 200_000);

    // Swap 10_000 A → B on a 1.1M/1.1M pool with 30bps fee.
    // amount_in_after_fee = 10_000 * 9970 / 10_000 = 9_970
    // amount_out = 1_100_000 * 9_970 / (1_100_000 + 9_970) = 9879 (truncated u128).
    h.swap(10_000, 1, DIRECTION_A_TO_B);
    let after_swap = h.read_pool();
    assert_eq!(after_swap.reserve_a, 1_110_000);
    assert!(after_swap.reserve_b < 1_100_000);
    assert_eq!(after_swap.cumulative_volume, 10_000);
    // Fee = 10_000 * 30 / 10_000 = 30.
    assert_eq!(after_swap.cumulative_fees, 30);
    assert!(after_swap.last_swap_price > 0);
    assert!(after_swap.k_last >= after_add.k_last); // fee grows k slightly

    // Burn all LP shares — reserves drop pro-rata.
    let reserve_a_before = after_swap.reserve_a;
    let reserve_b_before = after_swap.reserve_b;
    let total_supply_before = after_swap.total_lp_supply;
    let lp_shares = h.read_lp_position().lp_shares;
    h.remove_liquidity(lp_shares);
    let after_remove = h.read_pool();
    // withdrawn_a = shares * reserve_a_before / total_supply_before.
    let expected_withdraw_a = (lp_shares as u128 * reserve_a_before as u128
        / total_supply_before as u128) as u64;
    let expected_withdraw_b = (lp_shares as u128 * reserve_b_before as u128
        / total_supply_before as u128) as u64;
    assert_eq!(
        after_remove.reserve_a,
        reserve_a_before - expected_withdraw_a
    );
    assert_eq!(
        after_remove.reserve_b,
        reserve_b_before - expected_withdraw_b
    );
    assert_eq!(after_remove.total_lp_supply, total_supply_before - lp_shares);
    assert_eq!(h.read_lp_position().lp_shares, 0);
}

#[test]
fn amm_fork_constant_product_holds_within_tolerance() {
    if skip_if_missing(&[&amm_so_path()]) {
        return;
    }
    let mut h = AmmHarness::new();
    // No-fee pool so the invariant is purely about swap math truncation.
    h.initialize_pool(10_000_000, 10_000_000, 0);
    let initial_k = h.read_pool().k_last;

    // Alternating-direction swaps so k only loses precision from integer
    // truncation in the amount_out calculation. 5 rounds at ~0.5% per
    // swap is enough to expose any systemic drift. amount_in is varied
    // per iteration so no two txs hash identically under LiteSVM's
    // blockhash reuse across the tight loop (AlreadyProcessed guard).
    for i in 0..5 {
        let dir = if i % 2 == 0 {
            DIRECTION_A_TO_B
        } else {
            DIRECTION_B_TO_A
        };
        h.swap(50_000 + (i as u64) * 1_000, 1, dir);
    }

    let final_k = h.read_pool().k_last;
    // Zero-fee swap truncation rounds amount_out down, so k can only
    // grow or stay flat across swaps (never shrink).
    assert!(
        final_k >= initial_k,
        "constant-product invariant: k shrank from {} to {}",
        initial_k,
        final_k
    );
    // Per-swap drift is bounded by `reserve_in_new` (the truncation on
    // amount_out can miss at most 1 unit, and that unit stays in the
    // pool on the output side, multiplying by the post-swap input
    // reserve). For a 10M pool at 50k swaps that is at most ~1e7 per
    // swap — set the tolerance at a couple of that, i.e. 1e8 total
    // (1e-6 relative to the starting k of 1e14). Anything larger means
    // the swap math is dropping precision somewhere unexpected.
    let drift = final_k - initial_k;
    let tolerance = 100_000_000u64;
    assert!(
        drift < tolerance,
        "constant-product drift {} exceeded tolerance {} on 5 zero-fee swaps (relative: {})",
        drift,
        tolerance,
        (drift as f64) / (initial_k as f64)
    );
}

#[test]
fn amm_fork_rejects_slippage() {
    if skip_if_missing(&[&amm_so_path()]) {
        return;
    }
    let mut h = AmmHarness::new();
    h.initialize_pool(1_000_000, 1_000_000, 30);

    // The achievable output of a 10_000 A->B swap here is ~9_879.
    // Requesting min_amount_out = 1_000_000 forces slippage rejection.
    let data = AmmIx::Swap {
        amount_in: 10_000,
        min_amount_out: 1_000_000,
        direction: DIRECTION_A_TO_B,
    };
    let ix = Instruction::new_with_borsh(
        h.program_id,
        &data,
        vec![
            AccountMeta::new_readonly(h.trader.pubkey(), true),
            AccountMeta::new(h.pool.pubkey(), false),
        ],
    );
    let trader_kp = h.trader.insecure_clone();
    h.send_expect_fail(ix, &trader_kp, &[]);

    // Pool state did not move — failed tx reverts.
    let pool = h.read_pool();
    assert_eq!(pool.reserve_a, 1_000_000);
    assert_eq!(pool.reserve_b, 1_000_000);
    assert_eq!(pool.cumulative_volume, 0);
}

#[test]
fn amm_fork_is_deterministic() {
    if skip_if_missing(&[&amm_so_path()]) {
        return;
    }

    // The per-replay admin/pool/lp/trader keypairs are generated randomly
    // so the 32-byte identity fields legitimately differ between replays.
    // Determinism is about *protocol-state* byte stability: same seed,
    // same inputs → identical reserves, supply, cumulative counters,
    // k_last, fee_bps. Extract the non-identity fields and assert those.
    fn replay() -> (PoolState, LpPositionState) {
        let mut h = AmmHarness::new();
        h.initialize_pool(1_000_000, 1_000_000, 30);
        h.create_lp_position();
        h.add_liquidity(100_000, 100_000);
        h.swap(10_000, 1, DIRECTION_A_TO_B);
        h.swap(5_000, 1, DIRECTION_B_TO_A);
        (h.read_pool(), h.read_lp_position())
    }

    let (p1, lp1) = replay();
    let (p2, lp2) = replay();

    assert_eq!(p1.is_initialized, p2.is_initialized);
    assert_eq!(p1.reserve_a, p2.reserve_a);
    assert_eq!(p1.reserve_b, p2.reserve_b);
    assert_eq!(p1.total_lp_supply, p2.total_lp_supply);
    assert_eq!(p1.last_swap_price, p2.last_swap_price);
    assert_eq!(p1.cumulative_volume, p2.cumulative_volume);
    assert_eq!(p1.cumulative_fees, p2.cumulative_fees);
    assert_eq!(p1.fee_bps, p2.fee_bps);
    assert_eq!(p1.k_last, p2.k_last);
    assert_eq!(lp1.is_initialized, lp2.is_initialized);
    assert_eq!(lp1.lp_shares, lp2.lp_shares);
}
