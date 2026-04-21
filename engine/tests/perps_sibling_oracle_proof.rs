//! Perps-fork sibling-owned oracle proof.
//!
//! End-to-end proof that the owner-aware generic bootstrap + real
//! `push_oracle_price` write path behave correctly against a shipped
//! program surface (`perps-fork`).
//!
//! What this proof actually exercises:
//!
//! 1. A generic adapter that declares `[accounts.oracle]` as
//!    `kind = "shared"` with `owner.program_so = "<admin_mock_oracle.so>"`.
//!    The loader derives the oracle account's on-chain owner pubkey from
//!    the companion `target/deploy/admin_mock_oracle-keypair.json` — the
//!    same local-deploy convention the rest of the repo already uses.
//! 2. `GenericHarness::bootstrap` creates the oracle account owned by
//!    that sibling-program pubkey (NOT a silent fallback to `program_id`)
//!    and pre-populates it with admin-mock layout bytes at
//!    `base_price = 100`.
//! 3. Raw `initialize_market` + `open_position` instructions are
//!    dispatched against the harness's LiteSVM through the new
//!    `svm_mut()` accessor. The perps-fork program reads the oracle
//!    through the admin-mock byte layout and stores
//!    `position.entry_price = 100`.
//! 4. `<GenericHarness as Primitive>::push_oracle_price(40.0)` mutates
//!    the bound oracle account's bytes through the same layout
//!    dispatcher the engine's tick loop hits.
//! 5. A `close_position` against the post-shock oracle realizes the
//!    shock into the position's PnL. Post-shock collateral is lower
//!    than the no-shock baseline BY THE EXPECTED AMOUNT computed from
//!    the oracle delta — not because the account existence changed.
//!
//! Hardening notes:
//!
//! - Two separate harnesses (baseline vs shocked) run from byte-
//!   identical bootstrap state so only the oracle push differentiates
//!   them. If bootstrap itself drifted between runs the equality
//!   assertion on baseline collateral would fail first.
//! - Oracle account owner is read back after the push and asserted
//!   equal to the sibling keypair's pubkey. A regression where the
//!   push path silently overwrote the owner (which would break real
//!   on-chain reads that enforce owner asserts) fails this test
//!   loudly.
//! - Pairwise liquidation is deliberately out of scope. The generic
//!   runtime's `execute_action` still ignores `target_idx`; this proof
//!   asserts the close-path outcome changes because oracle bytes
//!   changed, which is the Sprint 9 scope.

#![cfg(feature = "litesvm-backend")]

use std::fs;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use borsh::{BorshDeserialize, BorshSerialize};
use riptide_engine::{
    adapter::{load_adapter, parse_adapter_str, OracleKind},
    primitive::{GenericBootstrapConfig, GenericHarness, Primitive},
    scenario::{oracle_layout_for, OracleUpdate},
};
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{read_keypair_file, Keypair, Signer},
};
use solana_transaction::Transaction;

// ---------------------------------------------------------------------------
// Local Borsh mirrors of perps-fork's instruction + account surfaces.
// Mirrored here rather than depending on the on-chain crate so this test
// tracks the shipped .so bytes, not a stale source reference.
// ---------------------------------------------------------------------------

const MARKET_STATE_LEN: usize = 113;
const POSITION_STATE_LEN: usize = 106;
const SIDE_LONG: u64 = 0;

#[derive(BorshSerialize)]
enum PerpsIx {
    InitializeMarket {
        max_leverage_bps: u64,
        liquidation_threshold_bps: u64,
    },
    DepositCollateral {
        amount: u64,
    },
    #[allow(dead_code)]
    WithdrawCollateral {
        amount: u64,
    },
    OpenPosition {
        side: u64,
        leverage_bps: u64,
        notional: u64,
    },
    ClosePosition,
    #[allow(dead_code)]
    LiquidatePosition,
}

#[derive(BorshDeserialize, Debug)]
struct PositionStateMirror {
    is_initialized: bool,
    _owner: [u8; 32],
    _market: [u8; 32],
    _side: u64,
    collateral: u64,
    notional: u64,
    entry_price: u64,
    _leverage_bps: u64,
    _liquidated: bool,
}

#[derive(BorshDeserialize, Debug)]
struct MarketStateMirror {
    is_initialized: bool,
    _admin: [u8; 32],
    oracle: [u8; 32],
    _max_leverage_bps: u64,
    _liquidation_threshold_bps: u64,
    total_oi_long: u64,
    _total_oi_short: u64,
    _total_collateral: u64,
    _cumulative_socialized_loss: u64,
}

// ---------------------------------------------------------------------------
// Path helpers.
// ---------------------------------------------------------------------------

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("engine crate has a parent workspace")
        .to_path_buf()
}

fn perps_fork_so() -> PathBuf {
    workspace_root().join("programs/perps-fork/target/deploy/perps_fork.so")
}

fn admin_mock_oracle_so() -> PathBuf {
    workspace_root().join("programs/admin_mock_oracle/target/deploy/admin_mock_oracle.so")
}

fn admin_mock_oracle_keypair() -> PathBuf {
    workspace_root()
        .join("programs/admin_mock_oracle/target/deploy/admin_mock_oracle-keypair.json")
}

fn perps_fork_idl() -> PathBuf {
    workspace_root().join("fixtures/idls/perps-fork.json")
}

/// Artifact presence check for the real-proof-path gate.
///
/// Mirrors the repo's load-bearing-gate discipline
/// (`replay_lending_whale_bad_debt::skip_if_missing`):
///
/// - `CI=<non-empty>` → HARD FAIL with a named `cargo build-sbf`
///   diagnostic. CI must never report green on this proof without
///   actually exercising perps-fork + admin_mock_oracle against the
///   new owner-aware bootstrap + push-oracle path.
/// - Local run → visible ATTENTION banner on stderr and the proof
///   returns early. The banner makes a silent skip impossible to
///   confuse with a genuine green pass.
fn skip_if_missing(paths: &[&Path]) -> bool {
    let missing: Vec<&&Path> = paths.iter().filter(|p| !p.exists()).collect();
    if missing.is_empty() {
        return false;
    }
    let ci = std::env::var("CI").map(|v| !v.is_empty()).unwrap_or(false);
    if ci {
        let list: Vec<String> = missing.iter().map(|p| p.display().to_string()).collect();
        panic!(
            "CI={}: refusing to soft-skip real-proof-path gate on missing SBF \
             artifact(s): {}.\n\
             Rebuild with:\n  \
             cargo build-sbf --manifest-path programs/perps-fork/Cargo.toml\n  \
             cargo build-sbf --manifest-path programs/admin_mock_oracle/Cargo.toml\n  \
             cargo build-sbf --manifest-path programs/resource_grinder/Cargo.toml",
            std::env::var("CI").unwrap_or_default(),
            list.join(", "),
        );
    }
    for path in &missing {
        eprintln!(
            "\x1b[33mATTENTION\x1b[0m real-proof-path soft-skip: {} missing. \
             Rebuild with `cargo build-sbf` — this proof did NOT run.",
            path.display()
        );
    }
    true
}

fn tmpdir(name: &str) -> PathBuf {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    let root = ROOT
        .get_or_init(|| {
            let pid = std::process::id();
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            std::env::temp_dir().join(format!("riptide-perps-proof-{pid}-{nanos}"))
        })
        .clone();
    fs::create_dir_all(&root).unwrap();
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = root.join(format!("{name}-{seq}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}

// ---------------------------------------------------------------------------
// Adapter TOML. Mirrors the shipping perps-fork.toml account shape but
// *adds* the oracle binding the Sprint 9 engine work unblocks: shared
// account owned by admin_mock_oracle via the local sibling-program
// keypair convention, and a single declared `[[oracles]]` entry of
// `kind = "admin-mock"` that binds to that account.
// ---------------------------------------------------------------------------

fn perps_proof_adapter_toml(owner_clause: &str) -> String {
    let so = perps_fork_so().display().to_string();
    let idl = perps_fork_idl().display().to_string();
    format!(
        r#"
protocol = "generic"
program_so = "{so}"
idl_path = "{idl}"

[accounts.market]
kind = "shared"
space = 113

[accounts.position]
kind = "agent"
space = 106

[accounts.oracle]
kind = "shared"
space = 50
{owner_clause}

[instructions]
deposit_collateral  = {{ action = "deposit",  amount = "amount" }}
withdraw_collateral = {{ action = "withdraw", amount = "amount" }}

[state_mapping]
"market.max_leverage_bps"           = "market.max_leverage_bps"
"market.liquidation_threshold_bps"  = "market.liquidation_threshold_bps"
"market.total_oi_long"              = "market.total_oi_long"
"market.total_oi_short"             = "market.total_oi_short"
"market.total_collateral"           = "market.total_collateral"
"market.cumulative_socialized_loss" = "market.cumulative_socialized_loss"
"position.side"                     = "position.side"
"position.collateral"               = "position.collateral"
"position.notional"                 = "position.notional"
"position.entry_price"              = "position.entry_price"
"position.leverage_bps"             = "position.leverage_bps"
"position.liquidated"               = "position.liquidated"

[actions.deposit]
label = "Deposit collateral"
takes = ["amount"]

[actions.withdraw]
label = "Withdraw collateral"
takes = ["amount"]

[observations]
"market.max_leverage_bps"           = "uint"
"market.liquidation_threshold_bps"  = "uint"
"market.total_oi_long"              = "uint"
"market.total_oi_short"             = "uint"
"market.total_collateral"           = "uint"
"market.cumulative_socialized_loss" = "uint"
"position.side"                     = "uint"
"position.collateral"               = "uint"
"position.notional"                 = "uint"
"position.entry_price"              = "uint"
"position.leverage_bps"             = "uint"
"position.liquidated"               = "bool"

[personas.grinder]
label = "Perps baseline (proof)"
action_rate_multiplier = 1.0
action_weights = {{ deposit = 0.9, withdraw = 0.1 }}
triggers = []

[[oracles]]
name = "price_feed"
kind = "admin-mock"
account = "oracle"
base_price = 100.0
exponent = 0
"#
    )
}

// ---------------------------------------------------------------------------
// Raw-instruction dispatch helpers. Use the harness's admin/agents and
// the bound shared/agent accounts so the proof runs against the same
// state the adapter bootstrap materialized.
// ---------------------------------------------------------------------------

fn send_tx(
    harness: &mut GenericHarness,
    payer: &Keypair,
    ix: Instruction,
    extra: &[&Keypair],
) {
    let blockhash = harness.svm().latest_blockhash();
    let mut signers: Vec<&Keypair> = vec![payer];
    for s in extra {
        if s.pubkey() != payer.pubkey() {
            signers.push(s);
        }
    }
    let tx = Transaction::new_signed_with_payer(
        &[ix],
        Some(&payer.pubkey()),
        &signers,
        blockhash,
    );
    harness
        .svm_mut()
        .send_transaction(tx)
        .unwrap_or_else(|error| panic!("send_transaction failed: {:?}", error.err));
}

fn initialize_market(harness: &mut GenericHarness) {
    let admin = harness.admin.insecure_clone();
    let market = harness
        .inspect_shared_account_pubkey("market")
        .expect("market bootstrapped");
    let oracle = harness
        .inspect_shared_account_pubkey("oracle")
        .expect("oracle bootstrapped");
    let program_id = harness.program_id;
    let ix = Instruction::new_with_borsh(
        program_id,
        &PerpsIx::InitializeMarket {
            max_leverage_bps: 100_000,
            liquidation_threshold_bps: 500,
        },
        vec![
            AccountMeta::new_readonly(admin.pubkey(), true),
            AccountMeta::new(market, false),
            AccountMeta::new_readonly(oracle, false),
        ],
    );
    send_tx(harness, &admin, ix, &[]);
}

fn deposit_collateral(harness: &mut GenericHarness, agent_idx: usize, amount: u64) {
    let trader = harness.agents[agent_idx].insecure_clone();
    let market = harness
        .inspect_shared_account_pubkey("market")
        .expect("market bootstrapped");
    let position = harness
        .inspect_agent_account_pubkey("position", agent_idx)
        .expect("position bootstrapped");
    let program_id = harness.program_id;
    let ix = Instruction::new_with_borsh(
        program_id,
        &PerpsIx::DepositCollateral { amount },
        vec![
            AccountMeta::new_readonly(trader.pubkey(), true),
            AccountMeta::new(market, false),
            AccountMeta::new(position, false),
        ],
    );
    send_tx(harness, &trader, ix, &[]);
}

fn open_long_position(
    harness: &mut GenericHarness,
    agent_idx: usize,
    leverage_bps: u64,
    notional: u64,
) {
    let trader = harness.agents[agent_idx].insecure_clone();
    let market = harness
        .inspect_shared_account_pubkey("market")
        .expect("market bootstrapped");
    let position = harness
        .inspect_agent_account_pubkey("position", agent_idx)
        .expect("position bootstrapped");
    let oracle = harness
        .inspect_shared_account_pubkey("oracle")
        .expect("oracle bootstrapped");
    let program_id = harness.program_id;
    let ix = Instruction::new_with_borsh(
        program_id,
        &PerpsIx::OpenPosition {
            side: SIDE_LONG,
            leverage_bps,
            notional,
        },
        vec![
            AccountMeta::new_readonly(trader.pubkey(), true),
            AccountMeta::new(market, false),
            AccountMeta::new(position, false),
            AccountMeta::new_readonly(oracle, false),
        ],
    );
    send_tx(harness, &trader, ix, &[]);
}

fn close_position(harness: &mut GenericHarness, agent_idx: usize) {
    let trader = harness.agents[agent_idx].insecure_clone();
    let market = harness
        .inspect_shared_account_pubkey("market")
        .expect("market bootstrapped");
    let position = harness
        .inspect_agent_account_pubkey("position", agent_idx)
        .expect("position bootstrapped");
    let oracle = harness
        .inspect_shared_account_pubkey("oracle")
        .expect("oracle bootstrapped");
    let program_id = harness.program_id;
    let ix = Instruction::new_with_borsh(
        program_id,
        &PerpsIx::ClosePosition,
        vec![
            AccountMeta::new_readonly(trader.pubkey(), true),
            AccountMeta::new(market, false),
            AccountMeta::new(position, false),
            AccountMeta::new_readonly(oracle, false),
        ],
    );
    send_tx(harness, &trader, ix, &[]);
}

fn read_position(harness: &GenericHarness, agent_idx: usize) -> PositionStateMirror {
    let pubkey = harness
        .inspect_agent_account_pubkey("position", agent_idx)
        .expect("position bootstrapped");
    let acc = harness
        .svm()
        .get_account(&pubkey)
        .expect("position account present");
    PositionStateMirror::try_from_slice(&acc.data[..POSITION_STATE_LEN])
        .expect("decode position state")
}

fn read_market(harness: &GenericHarness) -> MarketStateMirror {
    let pubkey = harness
        .inspect_shared_account_pubkey("market")
        .expect("market bootstrapped");
    let acc = harness
        .svm()
        .get_account(&pubkey)
        .expect("market account present");
    MarketStateMirror::try_from_slice(&acc.data[..MARKET_STATE_LEN])
        .expect("decode market state")
}

// ---------------------------------------------------------------------------
// Bootstrap the harness from an adapter TOML that declares the oracle
// binding. The TOML is written to a tmpdir so `load_adapter` does real
// path resolution + existence validation of the sibling-program `.so`.
// ---------------------------------------------------------------------------

fn bootstrap_harness(name: &str) -> GenericHarness {
    let admin_so = admin_mock_oracle_so();
    let owner_clause = format!(
        r#"owner = {{ program_so = "{}" }}"#,
        admin_so.display()
    );
    let toml = perps_proof_adapter_toml(&owner_clause);
    let adapter_path = tmpdir(name).join("adapter.toml");
    fs::write(&adapter_path, &toml).expect("write adapter toml");
    let adapter = load_adapter(&adapter_path).expect("load perps-proof adapter");
    GenericHarness::bootstrap(GenericBootstrapConfig {
        program_so: perps_fork_so(),
        idl_path: perps_fork_idl(),
        agent_count: 1,
        adapter,
    })
    .expect("bootstrap perps-proof harness")
}

// ---------------------------------------------------------------------------
// The proof.
// ---------------------------------------------------------------------------

/// Sibling-owned oracle account bootstrap + `push_oracle_price` writes
/// change the program-visible close outcome — not because the account
/// existence changed, but because the oracle bytes changed. This is the
/// real-proof-path gate for Sprint 9's generic oracle story.
#[test]
fn perps_close_outcome_shifts_after_generic_oracle_push() {
    if skip_if_missing(&[
        &perps_fork_so(),
        &admin_mock_oracle_so(),
        &admin_mock_oracle_keypair(),
        &perps_fork_idl(),
    ]) {
        return;
    }

    // --- Owner resolution happened via sibling-keypair convention. ---
    let sibling_keypair =
        read_keypair_file(&admin_mock_oracle_keypair()).expect("read sibling keypair");
    let expected_oracle_owner = sibling_keypair.pubkey();

    // --- Baseline run: bootstrap, deposit, open long 5x on notional=5_000,
    // close on FLAT oracle (no push). ---
    let mut baseline = bootstrap_harness("baseline");
    let baseline_oracle = baseline
        .inspect_shared_account("oracle")
        .expect("baseline oracle present");
    assert_eq!(
        baseline_oracle.owner, expected_oracle_owner,
        "bootstrap must place the oracle under sibling-program ownership; \
         got {} vs expected {}",
        baseline_oracle.owner, expected_oracle_owner
    );
    assert_ne!(
        baseline_oracle.owner, baseline.program_id,
        "bound oracle account must NOT be owned by the simulated program \
         when `owner.program_so` is declared"
    );
    let admin_layout = oracle_layout_for(OracleKind::AdminMock);
    let baseline_tick0 = admin_layout
        .decode(&baseline_oracle.data)
        .expect("decode tick-0 oracle bytes");
    assert_eq!(baseline_tick0.exponent, 0);
    assert!((baseline_tick0.price - 100.0).abs() < 1e-9);

    initialize_market(&mut baseline);
    // Sanity: the market wrote the bound oracle pubkey into its state.
    let market_state = read_market(&baseline);
    assert!(market_state.is_initialized);
    let oracle_pubkey = baseline
        .inspect_shared_account_pubkey("oracle")
        .expect("oracle pubkey");
    assert_eq!(
        Pubkey::from(market_state.oracle),
        oracle_pubkey,
        "perps market must bind to the generic-bootstrapped oracle pubkey"
    );

    deposit_collateral(&mut baseline, 0, 1_000);
    open_long_position(&mut baseline, 0, 50_000 /* 5x */, 5_000);
    let opened = read_position(&baseline, 0);
    assert!(opened.is_initialized);
    assert_eq!(opened.collateral, 1_000);
    assert_eq!(opened.notional, 5_000);
    assert_eq!(
        opened.entry_price, 100,
        "entry price must come from the adapter-declared oracle base_price"
    );
    let market_after_open = read_market(&baseline);
    assert_eq!(market_after_open.total_oi_long, 5_000);

    close_position(&mut baseline, 0);
    let baseline_closed = read_position(&baseline, 0);
    assert_eq!(baseline_closed.notional, 0);
    assert_eq!(
        baseline_closed.collateral, 1_000,
        "flat-oracle close must round-trip collateral exactly"
    );

    // --- Shocked run: bootstrap, deposit, open long 5x on notional=5_000,
    // push oracle 100 → 60, close on post-shock oracle. ---
    let mut shocked = bootstrap_harness("shocked");
    initialize_market(&mut shocked);
    deposit_collateral(&mut shocked, 0, 1_000);
    open_long_position(&mut shocked, 0, 50_000, 5_000);

    let pre_shock_bytes = shocked
        .inspect_shared_account("oracle")
        .expect("pre-shock oracle bytes")
        .data
        .clone();

    let shock = OracleUpdate { price: 60.0, exponent: 0 };
    shocked.push_oracle_price(&shock).expect("push oracle shock");

    let post_shock = shocked
        .inspect_shared_account("oracle")
        .expect("post-shock oracle bytes");
    assert_eq!(
        post_shock.owner, expected_oracle_owner,
        "push_oracle_price must preserve sibling-program ownership on the oracle account"
    );
    assert_ne!(
        pre_shock_bytes, post_shock.data,
        "push_oracle_price must materially mutate the oracle account bytes"
    );
    let shocked_decoded = admin_layout
        .decode(&post_shock.data)
        .expect("decode post-shock oracle");
    assert!((shocked_decoded.price - 60.0).abs() < 1e-9);

    close_position(&mut shocked, 0);
    let shocked_closed = read_position(&shocked, 0);

    // Long PnL at entry=100, current=60, notional=5_000:
    //   loss = notional * (entry - current) / entry = 5_000 * 40 / 100 = 2_000
    // Post-close collateral = 1_000 + (-2_000), clamped to zero on the
    // downside by position_equity.
    assert_eq!(
        shocked_closed.notional, 0,
        "position must be closed after post-shock close_position"
    );
    assert!(
        shocked_closed.collateral < baseline_closed.collateral,
        "shocked collateral ({}) must be strictly less than baseline collateral ({}) \
         because the oracle bytes changed — not because account existence changed",
        shocked_closed.collateral,
        baseline_closed.collateral
    );
    assert_eq!(
        shocked_closed.collateral, 0,
        "a 40%% long drawdown on 5x leverage must wipe the 1_000 margin \
         (loss = 2_000, clamped to zero by position_equity)"
    );

    // The delta isolates to the oracle path: both runs share an
    // identical bootstrap, identical init + open sequence, identical
    // notional — the shocked run only diverges after push_oracle_price.
    let delta = baseline_closed.collateral.saturating_sub(shocked_closed.collateral);
    assert_eq!(
        delta, 1_000,
        "close-outcome delta must equal the full posted margin when the \
         oracle move is large enough to wipe it (long 5x, -40%% price move)"
    );

    // And finally: a second push back to baseline (100) leaves bytes
    // byte-identical to what bootstrap wrote at tick 0. This proves the
    // write path is deterministic through the layout dispatcher.
    shocked
        .push_oracle_price(&OracleUpdate { price: 100.0, exponent: 0 })
        .expect("push oracle back to baseline");
    let restored = shocked
        .inspect_shared_account("oracle")
        .expect("post-restore oracle present");
    assert_eq!(
        &restored.data[..admin_layout.byte_len()],
        &pre_shock_bytes[..admin_layout.byte_len()],
        "pushing back to the declared base_price must be byte-identical to the \
         tick-0 bootstrap bytes"
    );
}

/// Narrower write-path gate: the same generic path can target
/// `kind = "pyth"` on a declared shared account. Proves that
/// `push_oracle_price` through GenericHarness produces real Pyth
/// aggregate-price bytes (the authoritative parser proof is
/// `pyth_real_layout::pyth_sdk_solana_parses_our_mock_unchanged`).
#[test]
fn generic_push_through_pyth_kind_mutates_real_pyth_bytes() {
    let grinder_so = workspace_root()
        .join("programs/resource_grinder/target/deploy/resource_grinder.so");
    let grinder_idl = workspace_root().join("fixtures/idls/resource-grinder.json");
    if skip_if_missing(&[&grinder_so, &grinder_idl]) {
        return;
    }
    // Use the literal-pubkey owner path — Pyth in production is owned by
    // its own published program id; literals keep the test hermetic.
    let literal = "FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH";
    let toml = format!(
        r#"
protocol = "generic"
program_so = "{so}"
idl_path = "{idl}"

[accounts.player]
kind = "agent"
space = 48

[accounts.oracle]
kind = "shared"
space = 3312
owner = {{ pubkey = "{literal}" }}

[instructions]
mine = {{ action = "mine", amount = "amount" }}

[state_mapping]
"player.gold" = "player.gold"

[actions.mine]
takes = ["amount"]

[observations]
"player.gold" = "uint"

[personas.grinder]
action_rate_multiplier = 1.0
action_weights = {{ mine = 1.0 }}

[[oracles]]
name = "price_feed"
kind = "pyth"
account = "oracle"
base_price = 150.0
exponent = -2
"#,
        so = grinder_so.display(),
        idl = grinder_idl.display(),
    );
    let adapter = parse_adapter_str(&toml, "pyth-narrow.toml").expect("parse adapter");
    let mut harness = GenericHarness::bootstrap(GenericBootstrapConfig {
        program_so: grinder_so,
        idl_path: grinder_idl,
        agent_count: 1,
        adapter,
    })
    .expect("bootstrap pyth-narrow harness");

    let layout = oracle_layout_for(OracleKind::Pyth);
    let expected_owner = Pubkey::from_str(literal).unwrap();

    let tick0 = harness
        .inspect_shared_account("oracle")
        .expect("pyth tick 0");
    assert_eq!(tick0.owner, expected_owner);
    let tick0_decoded = layout.decode(&tick0.data).expect("decode pyth tick 0");
    assert_eq!(tick0_decoded.exponent, -2);
    assert!((tick0_decoded.price - 150.0).abs() < 1e-6);

    // Push a shock through the generic path — real Pyth layout bytes
    // must land on the account.
    harness
        .push_oracle_price(&OracleUpdate { price: 75.5, exponent: -2 })
        .expect("push pyth shock");
    let post = harness
        .inspect_shared_account("oracle")
        .expect("pyth post-push");
    assert_eq!(post.owner, expected_owner);
    assert_eq!(post.data.len(), 3312, "real Pyth layout stays at 3312 bytes");
    let post_decoded = layout.decode(&post.data).expect("decode pyth post-push");
    assert_eq!(post_decoded.exponent, -2);
    assert!(
        (post_decoded.price - 75.5).abs() < 1e-6,
        "generic push_oracle_price through kind=\"pyth\" must write real Pyth \
         aggregate-price bytes; got {}",
        post_decoded.price
    );
    assert_ne!(tick0.data, post.data);
}
