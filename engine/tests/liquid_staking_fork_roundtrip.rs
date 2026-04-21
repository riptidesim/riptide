//! Liquid-staking-fork LiteSVM round-trip (T01 gate, Sprint 10).
//!
//! End-to-end coverage that the shipped `liquid_staking_fork.so` loads
//! in LiteSVM and exercises every instruction of the liquid-staking
//! surface: `initialize_pool → stake → request_unstake → claim_unstake`
//! plus the stress mutation `apply_slash`.
//!
//! State-machine contract (load-bearing for the queue proof):
//!
//! - `stake(amt)` grows `total_assets` by `amt` in full, but only
//!   `RESERVE_FRACTION_BPS` bps of `amt` lands in `reserve_buffer`.
//!   The remainder is treated as delegated stake. Any redemption
//!   beyond that reserve fraction therefore cannot settle from the
//!   buffer and falls to the withdrawal queue.
//! - `apply_slash(bps)` hits delegated stake only
//!   (`total_assets - reserve_buffer`), preserving the liquid buffer
//!   and keeping `reserve_buffer <= total_assets` naturally.
//! - `apply_slash` is strictly authority-gated: a lazy-init pool
//!   (admin == [0;32]) rejects every slash attempt.
//!
//! Five tests:
//! 1. `liquid_staking_fork_roundtrip_full_path` — init → stake →
//!    request-covered → claim.
//! 2. `liquid_staking_fork_withdrawal_queue_fires_and_settles` —
//!    request exceeding the reserve fraction lands on `pending_*`;
//!    subsequent stakes refill reserve and a later claim settles.
//! 3. `liquid_staking_fork_depeg_via_slash` — slash depegs the
//!    exchange rate; post-slash redemptions price at the new rate.
//! 4. `liquid_staking_fork_rejects_unstake_after_full_collapse` —
//!    exchange-rate collapse to zero is rejected by `request_unstake`.
//! 5. `liquid_staking_fork_apply_slash_rejects_on_lazy_init_pool` —
//!    the lazy-init authority hole is closed: slash requires an
//!    explicitly-initialized admin.
//! 6. `liquid_staking_fork_is_deterministic` — two replays produce
//!    byte-identical non-identity pool + stake-account state.

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
//     `programs/liquid-staking-fork/src/state.rs`. ---

const POOL_STATE_LEN: usize = 1 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 8; // 121
const STAKE_ACCOUNT_LEN: usize = 1 + 32 + 32 + 8 + 8 + 8 + 8; // 97

// --- Borsh mirror of the on-chain instruction enum. ---

#[derive(BorshSerialize)]
enum LsIx {
    InitializePool {
        initial_exchange_rate_bps: u64,
    },
    Stake {
        amount: u64,
    },
    RequestUnstake {
        lst_amount: u64,
    },
    ClaimUnstake,
    ApplySlash {
        slash_bps: u64,
    },
}

// --- Borsh mirrors of the account state. ---

#[derive(BorshDeserialize, Debug, PartialEq, Eq)]
struct PoolState {
    is_initialized: bool,
    admin: [u8; 32],
    oracle: [u8; 32],
    total_assets: u64,
    lst_supply: u64,
    reserve_buffer: u64,
    pending_unstake_assets: u64,
    pending_unstake_count: u64,
    exchange_rate_bps: u64,
    cumulative_slashed: u64,
}

#[derive(BorshDeserialize, Debug, PartialEq, Eq)]
struct StakeAccountState {
    is_initialized: bool,
    owner: [u8; 32],
    pool: [u8; 32],
    lst_balance: u64,
    pending_unstake_assets: u64,
    claimable_assets: u64,
    cumulative_claimed: u64,
}

// --- Path helpers + hard-fail-under-CI skip gate. ---

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("engine crate has a parent")
        .to_path_buf()
}

fn ls_so_path() -> PathBuf {
    workspace_root()
        .join("programs/liquid-staking-fork/target/deploy/liquid_staking_fork.so")
}

/// Mirrors the load-bearing-gate discipline used by
/// `perps_sibling_oracle_proof::skip_if_missing`:
/// - `CI=<non-empty>` → HARD FAIL with a named `cargo build-sbf`
///   diagnostic. CI must never report green on the T01/T02 gate
///   without actually exercising the liquid-staking bundle.
/// - Local run → visible ATTENTION banner on stderr and the test
///   returns early. The banner makes a silent skip impossible to
///   confuse with a genuine pass.
fn skip_if_missing(paths: &[&Path]) -> bool {
    let missing: Vec<&&Path> = paths.iter().filter(|p| !p.exists()).collect();
    if missing.is_empty() {
        return false;
    }
    let ci = std::env::var("CI").map(|v| !v.is_empty()).unwrap_or(false);
    if ci {
        let list: Vec<String> = missing.iter().map(|p| p.display().to_string()).collect();
        panic!(
            "CI={}: refusing to soft-skip Sprint 10 T01 gate on missing SBF \
             artifact(s): {}.\n\
             Rebuild with:\n  \
             cargo build-sbf --manifest-path programs/liquid-staking-fork/Cargo.toml",
            std::env::var("CI").unwrap_or_default(),
            list.join(", "),
        );
    }
    for path in &missing {
        eprintln!(
            "\x1b[33mATTENTION\x1b[0m T01 soft-skip: {} missing. \
             Rebuild with `cargo build-sbf` — this round-trip did NOT run.",
            path.display()
        );
    }
    true
}

// --- Harness. ---

struct LsHarness {
    svm: LiteSVM,
    program_id: Pubkey,
    admin: Keypair,
    pool: Keypair,
    staker: Keypair,
    stake_account: Keypair,
    oracle_sentinel: Pubkey,
}

impl LsHarness {
    fn new() -> Self {
        let mut svm = LiteSVM::new().with_builtins().with_sysvars();

        let program_id = Pubkey::new_unique();
        svm.add_program(program_id, &std::fs::read(ls_so_path()).unwrap())
            .expect("load liquid_staking_fork.so");

        let admin = Keypair::new();
        let staker = Keypair::new();
        svm.airdrop(&admin.pubkey(), 500_000_000_000).unwrap();
        svm.airdrop(&staker.pubkey(), 500_000_000_000).unwrap();

        Self {
            svm,
            program_id,
            admin,
            pool: Keypair::new(),
            staker,
            stake_account: Keypair::new(),
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

    fn allocate_pool(&mut self) {
        let admin_kp = self.admin.insecure_clone();
        let pool_kp = self.pool.insecure_clone();
        let program_id = self.program_id;
        self.create_and_own(&admin_kp, &pool_kp, POOL_STATE_LEN, &program_id);
    }

    fn initialize_pool(&mut self, initial_exchange_rate_bps: u64) {
        self.allocate_pool();
        let data = LsIx::InitializePool {
            initial_exchange_rate_bps,
        };
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

    fn create_stake_account(&mut self) {
        let staker_kp = self.staker.insecure_clone();
        let stake_account_kp = self.stake_account.insecure_clone();
        let program_id = self.program_id;
        self.create_and_own(&staker_kp, &stake_account_kp, STAKE_ACCOUNT_LEN, &program_id);
    }

    fn stake(&mut self, amount: u64) {
        let data = LsIx::Stake { amount };
        let ix = Instruction::new_with_borsh(
            self.program_id,
            &data,
            vec![
                AccountMeta::new_readonly(self.staker.pubkey(), true),
                AccountMeta::new(self.pool.pubkey(), false),
                AccountMeta::new(self.stake_account.pubkey(), false),
            ],
        );
        let staker_kp = self.staker.insecure_clone();
        self.send(ix, &staker_kp, &[]);
    }

    fn request_unstake(&mut self, lst_amount: u64) {
        let data = LsIx::RequestUnstake { lst_amount };
        let ix = Instruction::new_with_borsh(
            self.program_id,
            &data,
            vec![
                AccountMeta::new_readonly(self.staker.pubkey(), true),
                AccountMeta::new(self.pool.pubkey(), false),
                AccountMeta::new(self.stake_account.pubkey(), false),
            ],
        );
        let staker_kp = self.staker.insecure_clone();
        self.send(ix, &staker_kp, &[]);
    }

    fn claim_unstake(&mut self) {
        let data = LsIx::ClaimUnstake;
        let ix = Instruction::new_with_borsh(
            self.program_id,
            &data,
            vec![
                AccountMeta::new_readonly(self.staker.pubkey(), true),
                AccountMeta::new(self.pool.pubkey(), false),
                AccountMeta::new(self.stake_account.pubkey(), false),
            ],
        );
        let staker_kp = self.staker.insecure_clone();
        self.send(ix, &staker_kp, &[]);
    }

    fn apply_slash(&mut self, slash_bps: u64) {
        let data = LsIx::ApplySlash { slash_bps };
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

    fn read_stake_account(&self) -> StakeAccountState {
        let acc = self.svm.get_account(&self.stake_account.pubkey()).unwrap();
        StakeAccountState::try_from_slice(&acc.data[..STAKE_ACCOUNT_LEN])
            .expect("decode stake account")
    }
}

// --- Tests ---

#[test]
fn liquid_staking_fork_roundtrip_full_path() {
    if skip_if_missing(&[&ls_so_path()]) {
        return;
    }

    let mut h = LsHarness::new();
    // 1:1 exchange rate.
    h.initialize_pool(10_000);
    let after_init = h.read_pool();
    assert!(after_init.is_initialized);
    assert_eq!(after_init.exchange_rate_bps, 10_000);
    assert_eq!(after_init.lst_supply, 0);
    assert_eq!(after_init.total_assets, 0);
    assert_eq!(after_init.reserve_buffer, 0);

    h.create_stake_account();

    // Stake 1_000 underlying at 1:1 → 1_000 LST minted.
    // total_assets += 1_000 (full amount).
    // reserve_buffer += 1_000 * 2000 / 10000 = 200 (RESERVE_FRACTION_BPS).
    h.stake(1_000);
    let after_stake_pool = h.read_pool();
    let after_stake_acct = h.read_stake_account();
    assert_eq!(after_stake_pool.total_assets, 1_000);
    assert_eq!(after_stake_pool.reserve_buffer, 200);
    assert_eq!(after_stake_pool.lst_supply, 1_000);
    assert_eq!(after_stake_acct.lst_balance, 1_000);

    // Request 100 LST → owed=100 assets at 1:1, reserve=200 covers →
    // settles immediately into claimable.
    h.request_unstake(100);
    let after_req_pool = h.read_pool();
    let after_req_acct = h.read_stake_account();
    assert_eq!(after_req_pool.lst_supply, 900);
    assert_eq!(after_req_pool.total_assets, 900);
    assert_eq!(after_req_pool.reserve_buffer, 100);
    assert_eq!(after_req_pool.pending_unstake_count, 0);
    assert_eq!(after_req_acct.lst_balance, 900);
    assert_eq!(after_req_acct.claimable_assets, 100);
    assert_eq!(after_req_acct.pending_unstake_assets, 0);

    // Claim flushes claimable into cumulative_claimed.
    h.claim_unstake();
    let after_claim_pool = h.read_pool();
    let after_claim_acct = h.read_stake_account();
    // Pool totals unchanged — they already dropped at request time.
    assert_eq!(after_claim_pool.total_assets, 900);
    assert_eq!(after_claim_pool.reserve_buffer, 100);
    assert_eq!(after_claim_acct.claimable_assets, 0);
    assert_eq!(after_claim_acct.cumulative_claimed, 100);

    // A second claim with nothing claimable or settle-able is NothingToClaim.
    let data = LsIx::ClaimUnstake;
    let ix = Instruction::new_with_borsh(
        h.program_id,
        &data,
        vec![
            AccountMeta::new_readonly(h.staker.pubkey(), true),
            AccountMeta::new(h.pool.pubkey(), false),
            AccountMeta::new(h.stake_account.pubkey(), false),
        ],
    );
    let staker_kp = h.staker.insecure_clone();
    h.send_expect_fail(ix, &staker_kp, &[]);
}

#[test]
fn liquid_staking_fork_withdrawal_queue_fires_and_settles() {
    if skip_if_missing(&[&ls_so_path()]) {
        return;
    }

    // Load-bearing proof that the queue branch is reachable in
    // single-agent flows — covers R1.2's "withdrawal queue / pending
    // redemption claims" requirement for Sprint 10.
    let mut h = LsHarness::new();
    h.initialize_pool(10_000);
    h.create_stake_account();

    // Stake 1_000 → total=1_000, reserve=200, supply=1_000.
    h.stake(1_000);
    let after_stake = h.read_pool();
    assert_eq!(after_stake.total_assets, 1_000);
    assert_eq!(after_stake.reserve_buffer, 200);

    // Request 500 LST → owed=500, reserve=200 < 500 → QUEUE BRANCH.
    h.request_unstake(500);
    let queued_pool = h.read_pool();
    let queued_acct = h.read_stake_account();
    assert_eq!(
        queued_pool.pending_unstake_count, 1,
        "queue must have exactly one pending entry"
    );
    assert_eq!(queued_pool.pending_unstake_assets, 500);
    assert_eq!(
        queued_pool.reserve_buffer, 200,
        "reserve must NOT drain on the queue path"
    );
    assert_eq!(
        queued_pool.total_assets, 1_000,
        "total_assets stays because the queued liability still exists"
    );
    assert_eq!(
        queued_pool.lst_supply, 500,
        "LST is burned up-front even on the queue path"
    );
    assert_eq!(queued_acct.pending_unstake_assets, 500);
    assert_eq!(queued_acct.claimable_assets, 0);
    assert_eq!(queued_acct.lst_balance, 500);

    // Claim now: no claimable, pending 500 > reserve 200 → rejected.
    let data = LsIx::ClaimUnstake;
    let ix = Instruction::new_with_borsh(
        h.program_id,
        &data,
        vec![
            AccountMeta::new_readonly(h.staker.pubkey(), true),
            AccountMeta::new(h.pool.pubkey(), false),
            AccountMeta::new(h.stake_account.pubkey(), false),
        ],
    );
    let staker_kp = h.staker.insecure_clone();
    h.send_expect_fail(ix, &staker_kp, &[]);

    // Further stakes top up reserve (20% of each stake). Need reserve
    // to reach >= 500 to settle the queue. Currently reserve=200.
    // Each ~1_000 stake adds 200 to reserve. Stagger the amounts so
    // the two transactions hash distinctly under LiteSVM's
    // AlreadyProcessed dedup (same pattern amm-fork roundtrip uses).
    // 1_001 * 2000 / 10_000 and 1_002 * 2000 / 10_000 both truncate
    // to 200, so reserve still reaches exactly 600.
    h.stake(1_001);
    h.stake(1_002);
    let restocked = h.read_pool();
    assert_eq!(restocked.reserve_buffer, 600);
    assert!(restocked.reserve_buffer >= queued_pool.pending_unstake_assets);

    // Expire the prior blockhash so the successful claim tx hashes
    // distinctly from the earlier failed ClaimUnstake (zero-arg
    // instructions share bytes; LiteSVM's AlreadyProcessed set dedupes
    // on signature, so a fresh blockhash is the simplest way to
    // distinguish the two).
    h.svm.expire_blockhash();

    // Claim now settles the queued entry.
    h.claim_unstake();
    let settled_pool = h.read_pool();
    let settled_acct = h.read_stake_account();
    assert_eq!(settled_acct.pending_unstake_assets, 0);
    assert_eq!(settled_pool.pending_unstake_count, 0);
    assert_eq!(settled_pool.pending_unstake_assets, 0);
    // reserve dropped by the 500 settled amount (600 → 100).
    assert_eq!(settled_pool.reserve_buffer, 100);
    // total_assets = 1_000 (initial) + 1_001 + 1_002 = 3_003, minus
    // the 500 settled claim = 2_503.
    assert_eq!(settled_pool.total_assets, 2_503);
    assert_eq!(settled_acct.cumulative_claimed, 500);
}

#[test]
fn liquid_staking_fork_queue_count_tracks_accounts_not_calls() {
    if skip_if_missing(&[&ls_so_path()]) {
        return;
    }

    // Regression test for a pending_unstake_count over-count bug:
    // `pending_unstake_count` MUST track accounts with non-zero
    // pending, NOT individual request_unstake calls. Two queued
    // requests from one account aggregate into a single account-level
    // pending balance; the pool-level counter must reflect that, or
    // claim_unstake (which settles the aggregate once) leaves a
    // phantom queue entry behind and corrupts the queue-pressure
    // observation surface any proof artifact relies on.
    let mut h = LsHarness::new();
    h.initialize_pool(10_000);
    h.create_stake_account();

    // Stake 1_000 → total=1_000, reserve=200, supply=1_000.
    h.stake(1_000);

    // First queued request: owed=300, reserve=200 < 300 → queue.
    // Account transitions from pending=0 → pending=300. Count: 0 → 1.
    h.request_unstake(300);
    let after_first = h.read_pool();
    let acct_first = h.read_stake_account();
    assert_eq!(after_first.pending_unstake_count, 1);
    assert_eq!(after_first.pending_unstake_assets, 300);
    assert_eq!(acct_first.pending_unstake_assets, 300);

    // Second queued request on the SAME account: owed=250, reserve=200 < 250 → queue.
    // Account already has pending > 0, so count MUST stay at 1.
    // Account-level pending aggregates: 300 + 250 = 550.
    h.request_unstake(250);
    let after_second = h.read_pool();
    let acct_second = h.read_stake_account();
    assert_eq!(
        after_second.pending_unstake_count, 1,
        "pending_unstake_count must NOT double-count repeat queued requests from one account"
    );
    assert_eq!(after_second.pending_unstake_assets, 550);
    assert_eq!(acct_second.pending_unstake_assets, 550);

    // Restock reserve enough to cover 550.
    // 3 stakes add 200 each to reserve (1_000 * 2_000 / 10_000 = 200
    // truncated); after the two earlier stakes + three restocks:
    // reserve = 200 + 200 + 200 + 200 = 800.
    h.stake(1_001);
    h.stake(1_002);
    h.stake(1_003);
    let restocked = h.read_pool();
    assert_eq!(restocked.reserve_buffer, 800);

    // Claim settles the aggregated 550 pending and MUST decrement
    // count from 1 → 0 (not from 2 → 1, which was the bug).
    h.svm.expire_blockhash();
    h.claim_unstake();
    let settled = h.read_pool();
    let settled_acct = h.read_stake_account();
    assert_eq!(
        settled.pending_unstake_count, 0,
        "queue must be fully clear after the aggregated pending is settled — \
         a count > 0 here is the phantom-queue-entry regression"
    );
    assert_eq!(settled.pending_unstake_assets, 0);
    assert_eq!(settled_acct.pending_unstake_assets, 0);
    assert_eq!(settled_acct.cumulative_claimed, 550);
}

#[test]
fn liquid_staking_fork_depeg_via_slash() {
    if skip_if_missing(&[&ls_so_path()]) {
        return;
    }

    let mut h = LsHarness::new();
    h.initialize_pool(10_000);
    h.create_stake_account();

    // Stake 10_000 → total=10_000, reserve=2_000 (20%), supply=10_000.
    h.stake(10_000);
    let before = h.read_pool();
    assert_eq!(before.exchange_rate_bps, 10_000);
    assert_eq!(before.total_assets, 10_000);
    assert_eq!(before.reserve_buffer, 2_000);

    // 10% slash hits delegated only. delegated = 10_000 - 2_000 = 8_000.
    // slash_amount = 8_000 * 1000 / 10000 = 800.
    h.apply_slash(1_000);
    let after = h.read_pool();
    assert_eq!(after.cumulative_slashed, 800);
    assert_eq!(after.total_assets, 9_200);
    // Reserve stays untouched by slash — real LST cash is not at risk.
    assert_eq!(after.reserve_buffer, 2_000);
    // Rate = 9_200 * 10_000 / 10_000 = 9_200 bps. LST now redeems at
    // 0.92 underlying — the Kelp-style depeg signal the proof artifact
    // will fire on.
    assert_eq!(after.exchange_rate_bps, 9_200);
    assert!(
        after.exchange_rate_bps < before.exchange_rate_bps,
        "slash must depeg the LST (exchange_rate drops)"
    );

    // Post-slash redemption prices at the new rate.
    h.request_unstake(1_000);
    let acct = h.read_stake_account();
    // 1_000 LST * 9_200 / 10_000 = 920 assets. Reserve=2_000 covers.
    assert_eq!(acct.claimable_assets, 920);

    // Slash of 0 or > 10_000 bps rejected.
    let data_zero = LsIx::ApplySlash { slash_bps: 0 };
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

    let data_over = LsIx::ApplySlash { slash_bps: 10_001 };
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
fn liquid_staking_fork_rejects_unstake_after_full_collapse() {
    if skip_if_missing(&[&ls_so_path()]) {
        return;
    }

    // Full exchange-rate collapse to zero is unreachable via a single
    // slash in the delegated-only slash model — a single slash never
    // eats the reserve. Drive rate to zero by combining a drain and a
    // 100% slash: stake 1_000 → total=1_000, reserve=200. Request 200
    // LST, claim (drains reserve to 0; total=800). Now apply 100%
    // slash on delegated (800) → total=0, reserve=0, supply=800. Rate
    // recomputes to 0. `request_unstake` must reject instead of
    // burning LST for zero underlying.
    let mut h = LsHarness::new();
    h.initialize_pool(10_000);
    h.create_stake_account();
    h.stake(1_000);

    h.request_unstake(200);
    h.claim_unstake();
    let drained = h.read_pool();
    assert_eq!(drained.reserve_buffer, 0);
    assert_eq!(drained.total_assets, 800);
    assert_eq!(drained.lst_supply, 800);

    h.apply_slash(10_000);
    let wiped = h.read_pool();
    assert_eq!(wiped.total_assets, 0);
    assert_eq!(wiped.reserve_buffer, 0);
    assert_eq!(wiped.lst_supply, 800);
    assert_eq!(wiped.exchange_rate_bps, 0);

    // request_unstake at rate=0 is rejected — the program refuses to
    // burn LST for zero assets. Tests the `ZeroExchangeRate` guard in
    // `lst_to_assets`.
    let data = LsIx::RequestUnstake { lst_amount: 500 };
    let ix = Instruction::new_with_borsh(
        h.program_id,
        &data,
        vec![
            AccountMeta::new_readonly(h.staker.pubkey(), true),
            AccountMeta::new(h.pool.pubkey(), false),
            AccountMeta::new(h.stake_account.pubkey(), false),
        ],
    );
    let staker_kp = h.staker.insecure_clone();
    h.send_expect_fail(ix, &staker_kp, &[]);

    let acct_after = h.read_stake_account();
    let pool_after = h.read_pool();
    assert_eq!(
        acct_after.lst_balance, 800,
        "failed tx must leave LST balance intact"
    );
    assert_eq!(
        pool_after.lst_supply, 800,
        "failed tx must leave LST supply intact"
    );
}

#[test]
fn liquid_staking_fork_apply_slash_rejects_on_lazy_init_pool() {
    if skip_if_missing(&[&ls_so_path()]) {
        return;
    }

    // The generic harness bootstraps the pool account with zero bytes;
    // the first stake/request/claim triggers the processor's lazy-init
    // path, which seeds `admin = [0; 32]`. `apply_slash` must refuse
    // to fire against that state — the bundle's authority claim must
    // hold even on the generic-harness path (not only when a test
    // explicitly calls `initialize_pool` first).
    let mut h = LsHarness::new();
    h.allocate_pool(); // program-owned, zero-bytes, NOT initialized.
    h.create_stake_account();

    // First stake lazy-inits the pool with admin=[0;32].
    h.stake(1_000);
    let lazy = h.read_pool();
    assert!(lazy.is_initialized);
    assert_eq!(
        lazy.admin, [0u8; 32],
        "lazy-init path leaves admin unset — this is the exact state the \
         shipping adapter boots into"
    );

    // apply_slash on this pool must be rejected.
    let data = LsIx::ApplySlash { slash_bps: 1_000 };
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

    // Also verify a wholly-different signer is rejected (no "any
    // signer works when admin is unset" regression).
    let stranger = Keypair::new();
    h.svm
        .airdrop(&stranger.pubkey(), 10_000_000_000)
        .unwrap();
    let ix_stranger = Instruction::new_with_borsh(
        h.program_id,
        &LsIx::ApplySlash { slash_bps: 1_000 },
        vec![
            AccountMeta::new_readonly(stranger.pubkey(), true),
            AccountMeta::new(h.pool.pubkey(), false),
        ],
    );
    h.send_expect_fail(ix_stranger, &stranger, &[]);

    // Pool untouched.
    let unchanged = h.read_pool();
    assert_eq!(unchanged.cumulative_slashed, 0);
    assert_eq!(unchanged.total_assets, 1_000);
}

#[test]
fn liquid_staking_fork_is_deterministic() {
    if skip_if_missing(&[&ls_so_path()]) {
        return;
    }

    // Per-replay admin/pool/staker keypairs are random, so identity
    // fields legitimately differ between replays. Determinism is
    // about protocol-state byte stability — same inputs, same
    // numeric fields.
    fn replay() -> (PoolState, StakeAccountState) {
        let mut h = LsHarness::new();
        h.initialize_pool(10_000);
        h.create_stake_account();
        h.stake(1_000);
        h.request_unstake(150); // covered, reserve-drain
        h.apply_slash(500); // 5% of delegated
        h.request_unstake(300); // may queue
        h.stake(2_000); // refill reserve
        h.claim_unstake(); // settles whatever is settle-able
        (h.read_pool(), h.read_stake_account())
    }

    let (p1, s1) = replay();
    let (p2, s2) = replay();

    assert_eq!(p1.is_initialized, p2.is_initialized);
    assert_eq!(p1.total_assets, p2.total_assets);
    assert_eq!(p1.lst_supply, p2.lst_supply);
    assert_eq!(p1.reserve_buffer, p2.reserve_buffer);
    assert_eq!(p1.pending_unstake_assets, p2.pending_unstake_assets);
    assert_eq!(p1.pending_unstake_count, p2.pending_unstake_count);
    assert_eq!(p1.exchange_rate_bps, p2.exchange_rate_bps);
    assert_eq!(p1.cumulative_slashed, p2.cumulative_slashed);
    assert_eq!(s1.lst_balance, s2.lst_balance);
    assert_eq!(s1.pending_unstake_assets, s2.pending_unstake_assets);
    assert_eq!(s1.claimable_assets, s2.claimable_assets);
    assert_eq!(s1.cumulative_claimed, s2.cumulative_claimed);
}
