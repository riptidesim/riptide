use std::{error::Error, time::Instant};

use riptide_engine::harness::{
    lending::LendingProgramClient,
    setup::{
        create_program_account, default_pool_config, ORACLE_STATE_LEN, POOL_STATE_LEN,
        POSITION_STATE_LEN,
    },
};
use solana_client::rpc_client::RpcClient;
use solana_commitment_config::CommitmentConfig;
use solana_sdk::{
    pubkey::Pubkey,
    signature::{read_keypair_file, Keypair, Signer},
};
use solana_transaction::Transaction;

fn main() -> Result<(), Box<dyn Error>> {
    let rpc_url =
        std::env::var("RIPTIDE_RPC_URL").unwrap_or_else(|_| "http://127.0.0.1:8899".into());
    let payer_path = std::env::var("RIPTIDE_PAYER")?;
    let program_id: Pubkey = std::env::var("RIPTIDE_PROGRAM_ID")?.parse()?;
    let client = RpcClient::new_with_commitment(rpc_url, CommitmentConfig::confirmed());
    let payer = read_keypair_file(payer_path)?;
    let sdk = LendingProgramClient::new(program_id);

    let oracle = Keypair::new();
    let pool = Keypair::new();
    let liquidator = Keypair::new();
    let borrower_position = Keypair::new();
    let liquidator_position = Keypair::new();

    let rent_oracle = client.get_minimum_balance_for_rent_exemption(ORACLE_STATE_LEN)?;
    let rent_pool = client.get_minimum_balance_for_rent_exemption(POOL_STATE_LEN)?;
    let rent_position = client.get_minimum_balance_for_rent_exemption(POSITION_STATE_LEN)?;

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
                riptide_engine::harness::lending::LendingPoolConfig {
                    ltv_bps: 7_000,
                    liquidation_threshold_bps: 5_000,
                    ..default_pool_config()
                },
            ),
        ],
        &[
            &payer,
            &oracle,
            &pool,
            &borrower_position,
            &liquidator_position,
        ],
    )?;

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
            sdk.borrow(
                payer.pubkey(),
                pool.pubkey(),
                borrower_position.pubkey(),
                oracle.pubkey(),
                600_000,
            ),
        ],
        &[&payer],
    )?;

    send(
        &client,
        &payer,
        vec![
            sdk.deposit(
                payer.pubkey(),
                pool.pubkey(),
                liquidator_position.pubkey(),
                5_000,
            ),
            sdk.set_oracle_price(payer.pubkey(), oracle.pubkey(), 40, 0),
            sdk.liquidate(
                payer.pubkey(),
                pool.pubkey(),
                borrower_position.pubkey(),
                liquidator_position.pubkey(),
                oracle.pubkey(),
                2_000,
            ),
        ],
        &[&payer],
    )?;

    let iterations = 50u64;
    let start = Instant::now();
    for _ in 0..iterations {
        send(
            &client,
            &payer,
            vec![
                sdk.repay(
                    payer.pubkey(),
                    pool.pubkey(),
                    borrower_position.pubkey(),
                    10,
                ),
                sdk.deposit(
                    payer.pubkey(),
                    pool.pubkey(),
                    liquidator_position.pubkey(),
                    10,
                ),
            ],
            &[&payer],
        )?;
    }
    let elapsed = start.elapsed();
    let tx_count = iterations * 2;
    let throughput = tx_count as f64 / elapsed.as_secs_f64();

    println!("program_id={program_id}");
    println!("iterations={iterations}");
    println!("transactions={tx_count}");
    println!("elapsed_ms={}", elapsed.as_millis());
    println!("tx_per_second={throughput:.2}");
    println!(
        "borrower_position={} liquidator_position={} liquidator={}",
        borrower_position.pubkey(),
        liquidator_position.pubkey(),
        liquidator.pubkey()
    );

    Ok(())
}

fn send(
    client: &RpcClient,
    payer: &Keypair,
    instructions: Vec<solana_sdk::instruction::Instruction>,
    signers: &[&Keypair],
) -> Result<(), Box<dyn Error>> {
    let mut all_signers = vec![payer];
    all_signers.extend(
        signers
            .iter()
            .copied()
            .filter(|signer| signer.pubkey() != payer.pubkey()),
    );
    let recent_blockhash = client.get_latest_blockhash()?;
    let transaction = Transaction::new_signed_with_payer(
        &instructions,
        Some(&payer.pubkey()),
        &all_signers,
        recent_blockhash,
    );
    client.send_and_confirm_transaction(&transaction)?;
    Ok(())
}
