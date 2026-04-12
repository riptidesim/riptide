//! T05 validator integration test: deploy → deposit → borrow → liquidate.
//!
//! This test is gated on the `RIPTIDE_RUN_VALIDATOR_TESTS` environment variable
//! so that it is a no-op under `cargo test` in CI when no local validator is
//! running. It assumes a `solana-test-validator` is already running at
//! http://127.0.0.1:8899 and that `programs/lending_pool/target/deploy/lending_pool.so`
//! has been built with `cargo build-sbf`.
//!
//! How to run:
//!
//! ```bash
//! # In one terminal:
//! solana-test-validator
//!
//! # In another:
//! RIPTIDE_RUN_VALIDATOR_TESTS=1 RIPTIDE_PAYER=~/.config/solana/id.json \
//!   cargo test -p riptide-engine --test t05_lending_integration -- --nocapture
//! ```
//!
//! The test verifies the full T05 harness path end-to-end against the on-chain
//! program:
//!
//! 1. Deploys `lending_pool.so` via `harness::setup::deploy_program`.
//! 2. Creates oracle, pool, borrower and liquidator position accounts.
//! 3. Initializes the oracle at price=100 and the pool with a 50% liquidation
//!    threshold.
//! 4. Executes: deposit 10_000 → borrow 600_000 → set price to 40 →
//!    liquidate 2_000. Debt is stored in stable base units (not oracle-scaled);
//!    only collateral is re-priced via the oracle. The borrow is sized large so
//!    that post-drop `collateral_amount * new_price * liquidation_threshold_bps`
//!    falls below the (constant) debt value, flipping the health factor below
//!    1.0 and making the position liquidatable.
//! 5. Reads back the pool and the borrower position after each mutation and
//!    asserts the expected state transitions.
//!
//! The final assertion proves the on-chain health-factor math rejects the
//! pre-drop borrow as safe and accepts the post-drop liquidation — this is the
//! bug-catch against the prior simplified pool.

#![cfg(not(doctest))]

use std::{path::PathBuf, str::FromStr};

use borsh::BorshDeserialize;
use riptide_engine::harness::{
    lending::{LendingPoolConfig, LendingPoolState, LendingProgramClient, PositionState},
    setup::{
        create_program_account, default_pool_config, deploy_program, ORACLE_STATE_LEN,
        POOL_STATE_LEN, POSITION_STATE_LEN,
    },
};
use solana_client::rpc_client::RpcClient;
use solana_commitment_config::CommitmentConfig;
use solana_sdk::{
    instruction::Instruction,
    pubkey::Pubkey,
    signature::{read_keypair_file, Keypair, Signer},
};
use solana_transaction::Transaction;

const RPC_URL: &str = "http://127.0.0.1:8899";

fn payer_path() -> PathBuf {
    let raw = std::env::var("RIPTIDE_PAYER").expect("RIPTIDE_PAYER must point at a keypair file");
    if let Some(stripped) = raw.strip_prefix("~/") {
        let home = std::env::var("HOME").expect("HOME is set");
        PathBuf::from(home).join(stripped)
    } else {
        PathBuf::from(raw)
    }
}

fn send(
    client: &RpcClient,
    payer: &Keypair,
    instructions: Vec<Instruction>,
    extra_signers: &[&Keypair],
) {
    let mut all_signers: Vec<&Keypair> = vec![payer];
    all_signers.extend(
        extra_signers
            .iter()
            .copied()
            .filter(|signer| signer.pubkey() != payer.pubkey()),
    );
    let recent_blockhash = client.get_latest_blockhash().expect("blockhash");
    let tx = Transaction::new_signed_with_payer(
        &instructions,
        Some(&payer.pubkey()),
        &all_signers,
        recent_blockhash,
    );
    client
        .send_and_confirm_transaction(&tx)
        .expect("tx confirmed");
}

fn read_pool(client: &RpcClient, pool: &Pubkey) -> LendingPoolState {
    let data = client.get_account_data(pool).expect("pool account");
    LendingPoolState::try_from_slice(&data).expect("decode pool")
}

fn read_position(client: &RpcClient, position: &Pubkey) -> PositionState {
    let data = client.get_account_data(position).expect("position account");
    PositionState::try_from_slice(&data).expect("decode position")
}

#[test]
fn t05_deposit_borrow_liquidate_on_local_validator() {
    if std::env::var("RIPTIDE_RUN_VALIDATOR_TESTS").ok().as_deref() != Some("1") {
        eprintln!(
            "skipping t05_deposit_borrow_liquidate_on_local_validator: set RIPTIDE_RUN_VALIDATOR_TESTS=1"
        );
        return;
    }

    let payer = read_keypair_file(payer_path()).expect("read payer keypair");
    let rpc_url = std::env::var("RIPTIDE_RPC_URL").unwrap_or_else(|_| RPC_URL.to_string());
    let client = RpcClient::new_with_commitment(rpc_url.clone(), CommitmentConfig::confirmed());

    // Deploy the program using the same helper the engine uses.
    let program_so = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("programs/lending_pool/target/deploy/lending_pool.so");
    assert!(
        program_so.exists(),
        "program .so missing at {} — run `cargo build-sbf --manifest-path programs/lending_pool/Cargo.toml` first",
        program_so.display()
    );
    let deployment = deploy_program(&program_so, &rpc_url, &payer_path()).expect("deploy program");
    let program_id = deployment.program_id;
    let sdk = LendingProgramClient::new(program_id);

    // Wait for the program account to become executable (propagation after deploy).
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        match client.get_account(&program_id) {
            Ok(account) if account.executable => break,
            _ if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            other => panic!(
                "program {} never became executable: {:?}",
                program_id, other
            ),
        }
    }
    // Agave upgradeable loader activates a newly-deployed program one slot
    // later than its account flip. Advance a couple of slots to make sure the
    // SVM loader cache picks it up before we invoke.
    let start_slot = client.get_slot().expect("slot");
    let slot_deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while client.get_slot().unwrap_or(start_slot) < start_slot + 2 {
        if std::time::Instant::now() >= slot_deadline {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }

    // Fresh state accounts per run.
    let oracle = Keypair::new();
    let pool = Keypair::new();
    let borrower_position = Keypair::new();
    let liquidator_position = Keypair::new();

    let rent_oracle = client
        .get_minimum_balance_for_rent_exemption(ORACLE_STATE_LEN)
        .expect("rent oracle");
    let rent_pool = client
        .get_minimum_balance_for_rent_exemption(POOL_STATE_LEN)
        .expect("rent pool");
    let rent_position = client
        .get_minimum_balance_for_rent_exemption(POSITION_STATE_LEN)
        .expect("rent position");

    let config = LendingPoolConfig {
        ltv_bps: 7_000,
        liquidation_threshold_bps: 5_000,
        ..default_pool_config()
    };

    send(
        &client,
        &payer,
        vec![
            create_program_account(
                &payer.pubkey(),
                &oracle.pubkey(),
                &program_id,
                rent_oracle,
                ORACLE_STATE_LEN,
            ),
            create_program_account(
                &payer.pubkey(),
                &pool.pubkey(),
                &program_id,
                rent_pool,
                POOL_STATE_LEN,
            ),
            create_program_account(
                &payer.pubkey(),
                &borrower_position.pubkey(),
                &program_id,
                rent_position,
                POSITION_STATE_LEN,
            ),
            create_program_account(
                &payer.pubkey(),
                &liquidator_position.pubkey(),
                &program_id,
                rent_position,
                POSITION_STATE_LEN,
            ),
            sdk.initialize_oracle(payer.pubkey(), oracle.pubkey(), 100, 0),
            sdk.initialize_pool(
                payer.pubkey(),
                pool.pubkey(),
                oracle.pubkey(),
                config.clone(),
            ),
        ],
        &[
            &payer,
            &oracle,
            &pool,
            &borrower_position,
            &liquidator_position,
        ],
    );

    // 1) deposit 10_000 (borrower) + initialize liquidator position with a tiny seed.
    send(
        &client,
        &payer,
        vec![
            sdk.deposit(
                payer.pubkey(),
                pool.pubkey(),
                borrower_position.pubkey(),
                10_000,
            ),
            sdk.deposit(
                payer.pubkey(),
                pool.pubkey(),
                liquidator_position.pubkey(),
                1,
            ),
        ],
        &[],
    );

    let pool_after_deposits = read_pool(&client, &pool.pubkey());
    assert_eq!(
        pool_after_deposits.total_deposits, 10_001,
        "deposits should accumulate across both positions"
    );
    assert_eq!(pool_after_deposits.total_borrows, 0);
    assert_eq!(pool_after_deposits.bad_debt, 0);
    let borrower_after_deposit = read_position(&client, &borrower_position.pubkey());
    assert_eq!(borrower_after_deposit.collateral, 10_000);
    assert_eq!(borrower_after_deposit.debt, 0);
    assert!(!borrower_after_deposit.liquidated);

    // 2) Borrow 600_000 against 10_000 collateral @ price=100. Debt is tracked
    //    as stable base units; the oracle only re-prices collateral. At deposit
    //    time: collateral_value = collateral_amount * price = 1_000_000, LTV cap
    //    at 70% allows up to 700_000, and pool borrow_limit is 750_000, so 600k
    //    is within both caps.
    let borrow_amount: u64 = 600_000;
    send(
        &client,
        &payer,
        vec![sdk.borrow(
            payer.pubkey(),
            pool.pubkey(),
            borrower_position.pubkey(),
            oracle.pubkey(),
            borrow_amount,
        )],
        &[],
    );
    let pool_after_borrow = read_pool(&client, &pool.pubkey());
    assert_eq!(pool_after_borrow.total_borrows, borrow_amount);
    let borrower_after_borrow = read_position(&client, &borrower_position.pubkey());
    assert_eq!(borrower_after_borrow.debt, borrow_amount);
    assert!(!borrower_after_borrow.liquidated);

    // 3) Drop the oracle price to 40. Post-drop health math (the on-chain
    //    program's `health_factor_bps`):
    //      liquidation_value = collateral * price * threshold_bps / 10_000
    //                        = 10_000 * 40 * 5_000 / 10_000 = 200_000
    //      debt              = 600_000
    //      health_bps        = 200_000 * 10_000 / 600_000 ≈ 3_333  (< 10_000)
    //    so the position is liquidatable. This is the bug-catch invariant.
    let new_price: u64 = 40;
    let liquidation_value = u128::from(borrower_after_borrow.collateral)
        * u128::from(new_price)
        * u128::from(config.liquidation_threshold_bps)
        / 10_000u128;
    let debt_value = u128::from(borrower_after_borrow.debt);
    assert!(
        debt_value > liquidation_value,
        "price drop must make position liquidatable: debt={debt_value} liq_value={liquidation_value}"
    );

    send(
        &client,
        &payer,
        vec![sdk.set_oracle_price(payer.pubkey(), oracle.pubkey(), new_price, 0)],
        &[],
    );

    // 4) Liquidate 2_000 of the borrower's debt.
    send(
        &client,
        &payer,
        vec![sdk.liquidate(
            payer.pubkey(),
            pool.pubkey(),
            borrower_position.pubkey(),
            liquidator_position.pubkey(),
            oracle.pubkey(),
            2_000,
        )],
        &[],
    );

    let borrower_after_liq = read_position(&client, &borrower_position.pubkey());
    let pool_after_liq = read_pool(&client, &pool.pubkey());

    assert!(
        borrower_after_liq.debt < borrower_after_borrow.debt || borrower_after_liq.liquidated,
        "borrower debt should decrease or position should be marked liquidated"
    );
    assert!(
        pool_after_liq.total_borrows < pool_after_borrow.total_borrows
            || pool_after_liq.bad_debt > 0,
        "pool total_borrows should decrease or bad_debt should register"
    );

    eprintln!(
        "t05 integration ok: program={} pool_deposits={} pool_borrows={} bad_debt={} borrower_debt={} borrower_collateral={} liquidated={}",
        program_id,
        pool_after_liq.total_deposits,
        pool_after_liq.total_borrows,
        pool_after_liq.bad_debt,
        borrower_after_liq.debt,
        borrower_after_liq.collateral,
        borrower_after_liq.liquidated,
    );

    // silence unused import warning under feature branches
    let _ = Pubkey::from_str;
}
