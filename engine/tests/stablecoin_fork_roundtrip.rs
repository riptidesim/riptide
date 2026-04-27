//! Stablecoin-fork LiteSVM round-trip gate.
//!
//! End-to-end coverage that the shipped `stablecoin.so` loads in
//! LiteSVM and exercises every instruction of the stablecoin surface:
//! `initialize_pool → deposit_collateral → mint_stable → request_redeem
//! → claim_redeem` plus the stress mutation `apply_hedge_loss`.
//!
//! State-machine contract (load-bearing for the UXD-style proof):
//!
//! - `deposit_collateral(amt)` grows `collateral_assets` by `amt` in
//!   full, but only `RESERVE_FRACTION_BPS` bps of `amt` lands in
//!   `reserve_buffer_assets`. Any redemption beyond that reserve
//!   fraction therefore cannot settle from the buffer and falls to
//!   the redemption queue.
//! - `mint_stable(amt)` requires `amt <= free_collateral` on the
//!   position (`collateral_deposited - stable_minted`).
//! - `apply_hedge_loss(bps)` hits delegated collateral only
//!   (`collateral_assets - reserve_buffer_assets`), preserving
//!   `reserve_buffer_assets <= collateral_assets` naturally.
//! - `apply_hedge_loss` is strictly authority-gated: a lazy-init pool
//!   (admin == [0;32]) rejects every haircut attempt.
//!
//! Tests:
//! 1. `stablecoin_roundtrip_full_path` — init → deposit → mint →
//!    request-covered → claim.
//! 2. `stablecoin_redemption_queue_fires_and_settles` — request
//!    exceeding reserve lands on `pending_*`; refills restore reserve
//!    and a later claim clears.
//! 3. `stablecoin_queue_count_tracks_positions_not_calls` —
//!    repeat queued requests from one position aggregate to a single
//!    queue entry.
//! 4. `stablecoin_depeg_via_hedge_loss` — haircut drops
//!    `effective_collateral_ratio_bps` while supply stays intact.
//! 5. `stablecoin_apply_hedge_loss_rejects_on_lazy_init_pool` —
//!    closes the lazy-init authority hole.
//! 6. `stablecoin_is_deterministic` — two replays produce
//!    byte-identical non-identity pool + position state.

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

// --- Byte-level constants mirrored from
//     `programs/stablecoin/src/state.rs`. ---

const POOL_STATE_LEN: usize = 1 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 8; // 121
const POSITION_STATE_LEN: usize = 1 + 32 + 32 + 8 + 8 + 8 + 8 + 8; // 105

// --- Borsh mirror of the on-chain instruction enum. ---

#[derive(BorshSerialize)]
enum SbIx {
    InitializePool,
    DepositCollateral { amount: u64 },
    MintStable { amount: u64 },
    RequestRedeem { stable_amount: u64 },
    ClaimRedeem,
    ApplyHedgeLoss { loss_bps: u64 },
}

// --- Borsh mirrors of the account state. ---

#[derive(BorshDeserialize, Debug, PartialEq, Eq)]
struct PoolState {
    is_initialized: bool,
    admin: [u8; 32],
    oracle: [u8; 32],
    collateral_assets: u64,
    stable_supply: u64,
    reserve_buffer_assets: u64,
    pending_redemption_assets: u64,
    pending_redemption_count: u64,
    effective_collateral_ratio_bps: u64,
    cumulative_hedge_loss_bps: u64,
}

#[derive(BorshDeserialize, Debug, PartialEq, Eq)]
struct PositionState {
    is_initialized: bool,
    owner: [u8; 32],
    pool: [u8; 32],
    collateral_deposited: u64,
    stable_minted: u64,
    pending_redeem_assets: u64,
    claimable_collateral: u64,
    cumulative_claimed: u64,
}

// --- Path helpers + hard-fail-under-CI skip gate. ---

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("engine crate has a parent")
        .to_path_buf()
}

fn sb_so_path() -> PathBuf {
    workspace_root().join("programs/stablecoin/target/deploy/stablecoin.so")
}

/// Same discipline the liquid-staking roundtrip uses:
/// - `CI=<non-empty>` → HARD FAIL with a named `cargo build-sbf`
///   diagnostic. CI must never report green on the stablecoin bundle
///   gate without actually exercising the `.so`.
/// - Local run → visible ATTENTION banner on stderr and the test
///   returns early. No silent skip.
fn skip_if_missing(paths: &[&Path]) -> bool {
    let missing: Vec<&&Path> = paths.iter().filter(|p| !p.exists()).collect();
    if missing.is_empty() {
        return false;
    }
    let ci = std::env::var("CI").map(|v| !v.is_empty()).unwrap_or(false);
    if ci {
        let list: Vec<String> = missing.iter().map(|p| p.display().to_string()).collect();
        panic!(
            "CI={}: refusing to soft-skip stablecoin bundle gate on missing SBF \
             artifact(s): {}.\n\
             Rebuild with:\n  \
             cargo build-sbf --manifest-path programs/stablecoin/Cargo.toml",
            std::env::var("CI").unwrap_or_default(),
            list.join(", "),
        );
    }
    for path in &missing {
        eprintln!(
            "\x1b[33mATTENTION\x1b[0m stablecoin soft-skip: {} missing. \
             Rebuild with `cargo build-sbf` — this round-trip did NOT run.",
            path.display()
        );
    }
    true
}

// --- Harness. ---

struct SbHarness {
    svm: LiteSVM,
    program_id: Pubkey,
    admin: Keypair,
    pool: Keypair,
    user: Keypair,
    position: Keypair,
    oracle_sentinel: Pubkey,
}

impl SbHarness {
    fn new() -> Self {
        let mut svm = LiteSVM::new().with_builtins().with_sysvars();

        let program_id = Pubkey::new_unique();
        svm.add_program(program_id, &std::fs::read(sb_so_path()).unwrap())
            .expect("load stablecoin.so");

        let admin = Keypair::new();
        let user = Keypair::new();
        svm.airdrop(&admin.pubkey(), 500_000_000_000).unwrap();
        svm.airdrop(&user.pubkey(), 500_000_000_000).unwrap();

        Self {
            svm,
            program_id,
            admin,
            pool: Keypair::new(),
            user,
            position: Keypair::new(),
            oracle_sentinel: Pubkey::new_unique(),
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
        let tx =
            Transaction::new_signed_with_payer(&[ix], Some(&signer.pubkey()), &signers, blockhash);
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
        let tx =
            Transaction::new_signed_with_payer(&[ix], Some(&signer.pubkey()), &signers, blockhash);
        assert!(
            self.svm.send_transaction(tx).is_err(),
            "expected send_transaction to fail"
        );
    }

    fn create_and_own(&mut self, payer: &Keypair, target: &Keypair, space: usize, owner: &Pubkey) {
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

    fn allocate_pool(&mut self) {
        let admin_kp = self.admin.insecure_clone();
        let pool_kp = self.pool.insecure_clone();
        let program_id = self.program_id;
        self.create_and_own(&admin_kp, &pool_kp, POOL_STATE_LEN, &program_id);
    }

    fn initialize_pool(&mut self) {
        self.allocate_pool();
        let data = SbIx::InitializePool;
        let ix = Instruction::new_with_borsh(
            self.program_id,
            &data,
            vec![
                AccountMeta::new_readonly(self.admin.pubkey(), true),
                AccountMeta::new(self.pool.pubkey(), false),
                AccountMeta::new_readonly(self.oracle_sentinel, false),
            ],
        );
        let admin_kp = self.admin.insecure_clone();
        self.send(ix, &admin_kp, &[]);
    }

    fn create_position(&mut self) {
        let user_kp = self.user.insecure_clone();
        let position_kp = self.position.insecure_clone();
        let program_id = self.program_id;
        self.create_and_own(&user_kp, &position_kp, POSITION_STATE_LEN, &program_id);
    }

    fn deposit_collateral(&mut self, amount: u64) {
        let data = SbIx::DepositCollateral { amount };
        let ix = Instruction::new_with_borsh(
            self.program_id,
            &data,
            vec![
                AccountMeta::new_readonly(self.user.pubkey(), true),
                AccountMeta::new(self.pool.pubkey(), false),
                AccountMeta::new(self.position.pubkey(), false),
            ],
        );
        let user_kp = self.user.insecure_clone();
        self.send(ix, &user_kp, &[]);
    }

    fn mint_stable(&mut self, amount: u64) {
        let data = SbIx::MintStable { amount };
        let ix = Instruction::new_with_borsh(
            self.program_id,
            &data,
            vec![
                AccountMeta::new_readonly(self.user.pubkey(), true),
                AccountMeta::new(self.pool.pubkey(), false),
                AccountMeta::new(self.position.pubkey(), false),
            ],
        );
        let user_kp = self.user.insecure_clone();
        self.send(ix, &user_kp, &[]);
    }

    fn request_redeem(&mut self, stable_amount: u64) {
        let data = SbIx::RequestRedeem { stable_amount };
        let ix = Instruction::new_with_borsh(
            self.program_id,
            &data,
            vec![
                AccountMeta::new_readonly(self.user.pubkey(), true),
                AccountMeta::new(self.pool.pubkey(), false),
                AccountMeta::new(self.position.pubkey(), false),
            ],
        );
        let user_kp = self.user.insecure_clone();
        self.send(ix, &user_kp, &[]);
    }

    fn claim_redeem(&mut self) {
        let data = SbIx::ClaimRedeem;
        let ix = Instruction::new_with_borsh(
            self.program_id,
            &data,
            vec![
                AccountMeta::new_readonly(self.user.pubkey(), true),
                AccountMeta::new(self.pool.pubkey(), false),
                AccountMeta::new(self.position.pubkey(), false),
            ],
        );
        let user_kp = self.user.insecure_clone();
        self.send(ix, &user_kp, &[]);
    }

    fn apply_hedge_loss(&mut self, loss_bps: u64) {
        let data = SbIx::ApplyHedgeLoss { loss_bps };
        let ix = Instruction::new_with_borsh(
            self.program_id,
            &data,
            vec![
                AccountMeta::new_readonly(self.admin.pubkey(), true),
                AccountMeta::new(self.pool.pubkey(), false),
            ],
        );
        let admin_kp = self.admin.insecure_clone();
        self.send(ix, &admin_kp, &[]);
    }

    fn read_pool(&self) -> PoolState {
        let acc = self.svm.get_account(&self.pool.pubkey()).unwrap();
        PoolState::try_from_slice(&acc.data[..POOL_STATE_LEN]).expect("decode pool state")
    }

    fn read_position(&self) -> PositionState {
        let acc = self.svm.get_account(&self.position.pubkey()).unwrap();
        PositionState::try_from_slice(&acc.data[..POSITION_STATE_LEN])
            .expect("decode position state")
    }
}

// --- Tests ---

#[test]
fn stablecoin_roundtrip_full_path() {
    if skip_if_missing(&[&sb_so_path()]) {
        return;
    }

    let mut h = SbHarness::new();
    h.initialize_pool();
    let after_init = h.read_pool();
    assert!(after_init.is_initialized);
    assert_eq!(after_init.collateral_assets, 0);
    assert_eq!(after_init.stable_supply, 0);
    assert_eq!(after_init.reserve_buffer_assets, 0);
    assert_eq!(after_init.effective_collateral_ratio_bps, 10_000);
    assert_eq!(after_init.cumulative_hedge_loss_bps, 0);

    h.create_position();

    // Deposit 1_000 → collateral=1_000, reserve = 1_000 * 20% = 200.
    h.deposit_collateral(1_000);
    let after_deposit_pool = h.read_pool();
    let after_deposit_pos = h.read_position();
    assert_eq!(after_deposit_pool.collateral_assets, 1_000);
    assert_eq!(after_deposit_pool.reserve_buffer_assets, 200);
    assert_eq!(after_deposit_pool.stable_supply, 0);
    assert_eq!(after_deposit_pool.effective_collateral_ratio_bps, 10_000);
    assert_eq!(after_deposit_pos.collateral_deposited, 1_000);
    assert_eq!(after_deposit_pos.stable_minted, 0);

    // Mint 500 stable. free_collateral = 1_000, so 500 is valid.
    h.mint_stable(500);
    let after_mint_pool = h.read_pool();
    let after_mint_pos = h.read_position();
    assert_eq!(after_mint_pool.stable_supply, 500);
    assert_eq!(after_mint_pos.stable_minted, 500);
    // Ratio = 1_000 * 10_000 / 500 = 20_000 bps (200% backed).
    assert_eq!(after_mint_pool.effective_collateral_ratio_bps, 20_000);

    // Request redeem 100 → owed 100, reserve=200 covers → claimable.
    h.request_redeem(100);
    let after_req_pool = h.read_pool();
    let after_req_pos = h.read_position();
    assert_eq!(after_req_pool.stable_supply, 400);
    assert_eq!(after_req_pool.collateral_assets, 900);
    assert_eq!(after_req_pool.reserve_buffer_assets, 100);
    assert_eq!(after_req_pool.pending_redemption_count, 0);
    assert_eq!(after_req_pos.stable_minted, 400);
    assert_eq!(after_req_pos.claimable_collateral, 100);
    assert_eq!(after_req_pos.pending_redeem_assets, 0);
    assert_eq!(after_req_pos.collateral_deposited, 900);

    // Claim flushes claimable into cumulative_claimed.
    h.claim_redeem();
    let after_claim_pool = h.read_pool();
    let after_claim_pos = h.read_position();
    // Pool totals unchanged by claim — they dropped at request time.
    assert_eq!(after_claim_pool.collateral_assets, 900);
    assert_eq!(after_claim_pool.reserve_buffer_assets, 100);
    assert_eq!(after_claim_pos.claimable_collateral, 0);
    assert_eq!(after_claim_pos.cumulative_claimed, 100);

    // Double-claim with nothing pending is NothingToClaim.
    let data = SbIx::ClaimRedeem;
    let ix = Instruction::new_with_borsh(
        h.program_id,
        &data,
        vec![
            AccountMeta::new_readonly(h.user.pubkey(), true),
            AccountMeta::new(h.pool.pubkey(), false),
            AccountMeta::new(h.position.pubkey(), false),
        ],
    );
    let user_kp = h.user.insecure_clone();
    h.send_expect_fail(ix, &user_kp, &[]);
}

#[test]
fn stablecoin_redemption_queue_fires_and_settles() {
    if skip_if_missing(&[&sb_so_path()]) {
        return;
    }

    // Load-bearing proof that the queue branch is reachable in
    // single-agent flows — covers R1.2's "pending redemption queue /
    // reserve buffer exhaustion" pressure shape.
    let mut h = SbHarness::new();
    h.initialize_pool();
    h.create_position();

    // Deposit 1_000 → collateral=1_000, reserve=200.
    h.deposit_collateral(1_000);
    // Mint 600 stable. free_collateral=1_000 covers it.
    h.mint_stable(600);

    // Request redeem 500 → owed=500, reserve=200 < 500 → QUEUE.
    h.request_redeem(500);
    let queued_pool = h.read_pool();
    let queued_pos = h.read_position();
    assert_eq!(
        queued_pool.pending_redemption_count, 1,
        "queue must have exactly one pending entry"
    );
    assert_eq!(queued_pool.pending_redemption_assets, 500);
    assert_eq!(
        queued_pool.reserve_buffer_assets, 200,
        "reserve must NOT drain on the queue path"
    );
    assert_eq!(
        queued_pool.collateral_assets, 1_000,
        "collateral stays until the queued liability settles"
    );
    assert_eq!(
        queued_pool.stable_supply, 100,
        "stable is burned up-front even on the queue path"
    );
    assert_eq!(queued_pos.pending_redeem_assets, 500);
    assert_eq!(queued_pos.claimable_collateral, 0);
    assert_eq!(queued_pos.stable_minted, 100);

    // Claim now: no claimable, pending 500 > reserve 200 → rejected.
    let data = SbIx::ClaimRedeem;
    let ix = Instruction::new_with_borsh(
        h.program_id,
        &data,
        vec![
            AccountMeta::new_readonly(h.user.pubkey(), true),
            AccountMeta::new(h.pool.pubkey(), false),
            AccountMeta::new(h.position.pubkey(), false),
        ],
    );
    let user_kp = h.user.insecure_clone();
    h.send_expect_fail(ix, &user_kp, &[]);

    // Further deposits top up reserve (20% of each). Stagger sizes so
    // the two transactions hash distinctly under LiteSVM's
    // AlreadyProcessed dedup. 1_001 * 2_000 / 10_000 and
    // 1_002 * 2_000 / 10_000 both truncate to 200, so reserve reaches
    // exactly 600 — above the 500 queued liability.
    h.deposit_collateral(1_001);
    h.deposit_collateral(1_002);
    let restocked = h.read_pool();
    assert_eq!(restocked.reserve_buffer_assets, 600);
    assert!(restocked.reserve_buffer_assets >= queued_pool.pending_redemption_assets);

    // Expire the prior blockhash so the successful claim tx hashes
    // distinctly from the earlier failed ClaimRedeem.
    h.svm.expire_blockhash();

    h.claim_redeem();
    let settled_pool = h.read_pool();
    let settled_pos = h.read_position();
    assert_eq!(settled_pos.pending_redeem_assets, 0);
    assert_eq!(settled_pool.pending_redemption_count, 0);
    assert_eq!(settled_pool.pending_redemption_assets, 0);
    // Reserve drops by 500 (600 → 100).
    assert_eq!(settled_pool.reserve_buffer_assets, 100);
    // collateral = 1_000 + 1_001 + 1_002 - 500 = 2_503.
    assert_eq!(settled_pool.collateral_assets, 2_503);
    assert_eq!(settled_pos.cumulative_claimed, 500);
}

#[test]
fn stablecoin_queue_count_tracks_positions_not_calls() {
    if skip_if_missing(&[&sb_so_path()]) {
        return;
    }

    // Regression discipline inherited from liquid-staking:
    // `pending_redemption_count` MUST track positions with non-zero
    // pending, not individual `request_redeem` calls. Two queued
    // requests from one position aggregate to one account-level
    // pending balance; counting each call would leave a phantom queue
    // entry after claim settles the aggregate.
    let mut h = SbHarness::new();
    h.initialize_pool();
    h.create_position();

    h.deposit_collateral(1_000); // reserve=200
    h.mint_stable(800);

    // First queue: owed=300 > reserve=200 → queue. 0→1.
    h.request_redeem(300);
    let after_first = h.read_pool();
    assert_eq!(after_first.pending_redemption_count, 1);
    assert_eq!(after_first.pending_redemption_assets, 300);

    // Second queue on the SAME position: owed=250 > reserve=200 →
    // queue. Already pending > 0, count must stay 1.
    h.request_redeem(250);
    let after_second = h.read_pool();
    let pos_second = h.read_position();
    assert_eq!(
        after_second.pending_redemption_count, 1,
        "pending_redemption_count must NOT double-count repeat queued requests from one position"
    );
    assert_eq!(after_second.pending_redemption_assets, 550);
    assert_eq!(pos_second.pending_redeem_assets, 550);

    // Restock reserve to cover 550. 4 deposits * 200 each = 800.
    h.deposit_collateral(1_001);
    h.deposit_collateral(1_002);
    h.deposit_collateral(1_003);
    let restocked = h.read_pool();
    assert_eq!(restocked.reserve_buffer_assets, 800);

    h.svm.expire_blockhash();
    h.claim_redeem();
    let settled = h.read_pool();
    let settled_pos = h.read_position();
    assert_eq!(
        settled.pending_redemption_count, 0,
        "queue must be fully clear after the aggregated pending settles"
    );
    assert_eq!(settled.pending_redemption_assets, 0);
    assert_eq!(settled_pos.pending_redeem_assets, 0);
    assert_eq!(settled_pos.cumulative_claimed, 550);
}

#[test]
fn stablecoin_queued_redeem_locks_collateral_against_remint() {
    if skip_if_missing(&[&sb_so_path()]) {
        return;
    }

    // Regression: a queued redeem burns stable up front but leaves
    // `collateral_deposited` in place until `claim_redeem` settles
    // the reserve draw. If `MintStable`'s free-collateral gate did
    // not also carve out `pending_redeem_assets`, the same collateral
    // could back both the queued redemption claim AND a fresh mint —
    // a real double-spend of backing. This test proves the gate
    // holds under the queued path.
    let mut h = SbHarness::new();
    h.initialize_pool();
    h.create_position();

    // Deposit 1_000 → collateral=1_000, reserve=200.
    h.deposit_collateral(1_000);
    // Mint 800 — free_collateral = 1_000 before, 200 after.
    h.mint_stable(800);

    // Request redeem 500 → owed=500, reserve=200 < 500 → QUEUE.
    // stable_minted: 800 → 300. pending_redeem: 0 → 500.
    // collateral_deposited: stays 1_000 (queued path does not drain).
    h.request_redeem(500);
    let queued = h.read_position();
    assert_eq!(queued.stable_minted, 300);
    assert_eq!(queued.pending_redeem_assets, 500);
    assert_eq!(queued.collateral_deposited, 1_000);
    // Honest free_collateral after the fix: 1_000 - 300 - 500 = 200.
    // Before the fix this was 1_000 - 300 = 700 and a fresh 400-mint
    // succeeded against collateral already earmarked for the queue.

    // Attempt to mint 400 stable. Pre-fix: SUCCESS (double-spend
    // against queued collateral). Post-fix: MUST FAIL with
    // InsufficientFreeCollateral because free is only 200.
    let data_over = SbIx::MintStable { amount: 400 };
    let ix_over = Instruction::new_with_borsh(
        h.program_id,
        &data_over,
        vec![
            AccountMeta::new_readonly(h.user.pubkey(), true),
            AccountMeta::new(h.pool.pubkey(), false),
            AccountMeta::new(h.position.pubkey(), false),
        ],
    );
    let user_kp = h.user.insecure_clone();
    h.send_expect_fail(ix_over, &user_kp, &[]);

    // A mint of exactly the legitimate free amount (200) must still
    // succeed — the gate should be tight but not paranoid. This
    // guards against a future regression that over-subtracts.
    h.mint_stable(200);
    let after_legit = h.read_position();
    assert_eq!(after_legit.stable_minted, 500);
    assert_eq!(after_legit.pending_redeem_assets, 500);
    assert_eq!(after_legit.collateral_deposited, 1_000);

    // And the position is now fully earmarked: another 1-unit mint
    // must fail.
    let data_one_more = SbIx::MintStable { amount: 1 };
    let ix_one_more = Instruction::new_with_borsh(
        h.program_id,
        &data_one_more,
        vec![
            AccountMeta::new_readonly(h.user.pubkey(), true),
            AccountMeta::new(h.pool.pubkey(), false),
            AccountMeta::new(h.position.pubkey(), false),
        ],
    );
    h.send_expect_fail(ix_one_more, &user_kp, &[]);

    // Adding a fresh deposit reopens legitimate mint capacity —
    // the gate should track new deposits, not refuse forever.
    // Stagger the amount vs the earlier 1_000 deposit so the tx
    // hashes distinctly under LiteSVM's AlreadyProcessed dedup
    // (same discipline queue_fires_and_settles uses).
    h.deposit_collateral(1_001);
    // Now free = 2_001 - 500 - 500 = 1_001. Mint 1_000 must succeed.
    h.mint_stable(1_000);
    let after_topup = h.read_position();
    assert_eq!(after_topup.collateral_deposited, 2_001);
    assert_eq!(after_topup.stable_minted, 1_500);
    assert_eq!(after_topup.pending_redeem_assets, 500);
}

#[test]
fn stablecoin_depeg_via_hedge_loss() {
    if skip_if_missing(&[&sb_so_path()]) {
        return;
    }

    let mut h = SbHarness::new();
    h.initialize_pool();
    h.create_position();

    // Deposit 10_000 → collateral=10_000, reserve=2_000.
    // Mint 10_000 stable (1:1 fully backed at rest).
    h.deposit_collateral(10_000);
    h.mint_stable(10_000);
    let before = h.read_pool();
    assert_eq!(before.collateral_assets, 10_000);
    assert_eq!(before.stable_supply, 10_000);
    assert_eq!(before.reserve_buffer_assets, 2_000);
    // Fully backed at tick zero of the proof sequence.
    assert_eq!(before.effective_collateral_ratio_bps, 10_000);
    assert_eq!(before.cumulative_hedge_loss_bps, 0);

    // 10% haircut on delegated only. delegated = 10_000 - 2_000 = 8_000.
    // loss = 8_000 * 10% = 800.
    h.apply_hedge_loss(1_000);
    let after = h.read_pool();
    assert_eq!(after.cumulative_hedge_loss_bps, 1_000);
    assert_eq!(after.collateral_assets, 9_200);
    // Reserve untouched — real liquid cash is not what a hedge-venue
    // failure destroys.
    assert_eq!(after.reserve_buffer_assets, 2_000);
    // Stable supply untouched by the haircut.
    assert_eq!(after.stable_supply, 10_000);
    // Ratio = 9_200 * 10_000 / 10_000 = 9_200 bps — the UXD-style
    // under-backed signal the proof artifact fires on.
    assert_eq!(after.effective_collateral_ratio_bps, 9_200);
    assert!(
        after.effective_collateral_ratio_bps < before.effective_collateral_ratio_bps,
        "haircut must drop the effective collateral ratio"
    );

    // A further 20% haircut stacks. delegated now = 9_200 - 2_000 = 7_200.
    // loss = 7_200 * 20% = 1_440. collateral = 9_200 - 1_440 = 7_760.
    // ratio = 7_760 bps (under-backed; 77.6%).
    h.apply_hedge_loss(2_000);
    let after_second = h.read_pool();
    assert_eq!(after_second.cumulative_hedge_loss_bps, 3_000);
    assert_eq!(after_second.collateral_assets, 7_760);
    assert_eq!(after_second.effective_collateral_ratio_bps, 7_760);

    // Bounds: 0 and > 10_000 rejected.
    let data_zero = SbIx::ApplyHedgeLoss { loss_bps: 0 };
    let admin_kp = h.admin.insecure_clone();
    let ix_zero = Instruction::new_with_borsh(
        h.program_id,
        &data_zero,
        vec![
            AccountMeta::new_readonly(h.admin.pubkey(), true),
            AccountMeta::new(h.pool.pubkey(), false),
        ],
    );
    h.send_expect_fail(ix_zero, &admin_kp, &[]);

    let data_over = SbIx::ApplyHedgeLoss { loss_bps: 10_001 };
    let ix_over = Instruction::new_with_borsh(
        h.program_id,
        &data_over,
        vec![
            AccountMeta::new_readonly(h.admin.pubkey(), true),
            AccountMeta::new(h.pool.pubkey(), false),
        ],
    );
    h.send_expect_fail(ix_over, &admin_kp, &[]);
}

#[test]
fn stablecoin_apply_hedge_loss_rejects_on_lazy_init_pool() {
    if skip_if_missing(&[&sb_so_path()]) {
        return;
    }

    // The generic harness bootstraps the pool account with zero bytes;
    // the first deposit/mint triggers the processor's lazy-init path,
    // which seeds `admin = [0;32]`. `apply_hedge_loss` must refuse to
    // fire against that state — closes the same authority hole
    // liquid-staking closed for `apply_slash`.
    let mut h = SbHarness::new();
    h.allocate_pool(); // program-owned, zero-bytes, NOT initialized.
    h.create_position();

    // First deposit lazy-inits the pool with admin=[0;32].
    h.deposit_collateral(1_000);
    let lazy = h.read_pool();
    assert!(lazy.is_initialized);
    assert_eq!(
        lazy.admin, [0u8; 32],
        "lazy-init path leaves admin unset — the state the shipping adapter boots into"
    );

    // apply_hedge_loss on this pool must be rejected.
    let data = SbIx::ApplyHedgeLoss { loss_bps: 1_000 };
    let admin_kp = h.admin.insecure_clone();
    let ix = Instruction::new_with_borsh(
        h.program_id,
        &data,
        vec![
            AccountMeta::new_readonly(h.admin.pubkey(), true),
            AccountMeta::new(h.pool.pubkey(), false),
        ],
    );
    h.send_expect_fail(ix, &admin_kp, &[]);

    // A wholly-different signer is also rejected (no "any signer works
    // when admin is unset" regression).
    let stranger = Keypair::new();
    h.svm.airdrop(&stranger.pubkey(), 10_000_000_000).unwrap();
    let ix_stranger = Instruction::new_with_borsh(
        h.program_id,
        &SbIx::ApplyHedgeLoss { loss_bps: 1_000 },
        vec![
            AccountMeta::new_readonly(stranger.pubkey(), true),
            AccountMeta::new(h.pool.pubkey(), false),
        ],
    );
    h.send_expect_fail(ix_stranger, &stranger, &[]);

    // Pool untouched.
    let unchanged = h.read_pool();
    assert_eq!(unchanged.cumulative_hedge_loss_bps, 0);
    assert_eq!(unchanged.collateral_assets, 1_000);
}

#[test]
fn stablecoin_is_deterministic() {
    if skip_if_missing(&[&sb_so_path()]) {
        return;
    }

    // Per-replay keypairs are random, so identity fields legitimately
    // differ. Determinism is about protocol-state byte stability:
    // same inputs, same numeric fields.
    fn replay() -> (PoolState, PositionState) {
        let mut h = SbHarness::new();
        h.initialize_pool();
        h.create_position();
        h.deposit_collateral(1_000);
        h.mint_stable(500);
        h.request_redeem(100); // covered from reserve
        h.apply_hedge_loss(500); // 5% on delegated
        h.request_redeem(300); // may queue
        h.deposit_collateral(2_000); // refill reserve
        h.claim_redeem(); // settles whatever fits
        (h.read_pool(), h.read_position())
    }

    let (p1, s1) = replay();
    let (p2, s2) = replay();

    assert_eq!(p1.is_initialized, p2.is_initialized);
    assert_eq!(p1.collateral_assets, p2.collateral_assets);
    assert_eq!(p1.stable_supply, p2.stable_supply);
    assert_eq!(p1.reserve_buffer_assets, p2.reserve_buffer_assets);
    assert_eq!(p1.pending_redemption_assets, p2.pending_redemption_assets);
    assert_eq!(p1.pending_redemption_count, p2.pending_redemption_count);
    assert_eq!(
        p1.effective_collateral_ratio_bps,
        p2.effective_collateral_ratio_bps
    );
    assert_eq!(p1.cumulative_hedge_loss_bps, p2.cumulative_hedge_loss_bps);
    assert_eq!(s1.collateral_deposited, s2.collateral_deposited);
    assert_eq!(s1.stable_minted, s2.stable_minted);
    assert_eq!(s1.pending_redeem_assets, s2.pending_redeem_assets);
    assert_eq!(s1.claimable_collateral, s2.claimable_collateral);
    assert_eq!(s1.cumulative_claimed, s2.cumulative_claimed);
}
