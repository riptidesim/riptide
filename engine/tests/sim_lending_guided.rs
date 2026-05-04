use std::path::PathBuf;

use anyhow::Result;
use solana_account::Account;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
};

use riptide_sim::World;

const POOL_STATE_LEN: usize = 113;
const POSITION_STATE_LEN: usize = 49;
const ORACLE_STATE_LEN: usize = 50;

#[test]
fn sim_lending_guided_flow_resolves_remaining_accounts_in_user_code() -> Result<()> {
    let mut world = World::default();
    let program_id = world.load_program_from_so(
        repo_root().join("programs/lending_pool/target/deploy/lending_pool.so"),
    )?;
    let oracle = Pubkey::new_unique();
    let pool = Pubkey::new_unique();
    let position = Pubkey::new_unique();

    set_program_account(&mut world, oracle, program_id, ORACLE_STATE_LEN)?;
    set_program_account(&mut world, pool, program_id, POOL_STATE_LEN)?;
    set_program_account(&mut world, position, program_id, POSITION_STATE_LEN)?;

    world.process_transaction(
        &[
            lending_ix(
                program_id,
                vec![
                    AccountMeta::new_readonly(world.admin_pubkey(), true),
                    AccountMeta::new(oracle, false),
                ],
                lending_data(0, &[1], Some(0)),
            ),
            lending_ix(
                program_id,
                vec![
                    AccountMeta::new_readonly(world.admin_pubkey(), true),
                    AccountMeta::new(pool, false),
                    AccountMeta::new_readonly(oracle, false),
                ],
                initialize_pool_data(),
            ),
        ],
        Some("initialize_lending_world"),
    )?;

    let remaining_accounts = vec![AccountMeta::new_readonly(oracle, false)];
    world.process_transaction(
        &[
            lending_ix(
                program_id,
                vec![
                    AccountMeta::new_readonly(world.admin_pubkey(), true),
                    AccountMeta::new(pool, false),
                    AccountMeta::new(position, false),
                ],
                lending_data(3, &[1_000], None),
            ),
            lending_ix(
                program_id,
                [
                    vec![
                        AccountMeta::new_readonly(world.admin_pubkey(), true),
                        AccountMeta::new(pool, false),
                        AccountMeta::new(position, false),
                    ],
                    remaining_accounts,
                ]
                .concat(),
                lending_data(5, &[100], None),
            ),
            lending_ix(
                program_id,
                vec![
                    AccountMeta::new_readonly(world.admin_pubkey(), true),
                    AccountMeta::new(pool, false),
                    AccountMeta::new(position, false),
                ],
                lending_data(6, &[50], None),
            ),
        ],
        Some("deposit_borrow_repay"),
    )?;

    let position_account = world.get_account(&position).expect("position exists");
    assert_eq!(read_u64(&position_account.data, 32), 1_000);
    assert_eq!(read_u64(&position_account.data, 40), 50);
    Ok(())
}

fn initialize_pool_data() -> Vec<u8> {
    let mut data = vec![2];
    data.extend(5_000_u16.to_le_bytes());
    data.extend(8_000_u16.to_le_bytes());
    data.extend(500_u16.to_le_bytes());
    data.extend(0_u16.to_le_bytes());
    data.extend(1_000_000_u64.to_le_bytes());
    data.extend(1_000_000_u64.to_le_bytes());
    data
}

fn lending_data(variant: u8, u64_args: &[u64], i8_arg: Option<i8>) -> Vec<u8> {
    let mut data = vec![variant];
    for arg in u64_args {
        data.extend(arg.to_le_bytes());
    }
    if let Some(arg) = i8_arg {
        data.push(arg as u8);
    }
    data
}

fn lending_ix(program_id: Pubkey, accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
    Instruction {
        program_id,
        accounts,
        data,
    }
}

fn set_program_account(
    world: &mut World,
    pubkey: Pubkey,
    owner: Pubkey,
    space: usize,
) -> Result<()> {
    world.set_account(
        pubkey,
        Account {
            lamports: world.svm().minimum_balance_for_rent_exemption(space),
            data: vec![0; space],
            owner,
            ..Default::default()
        },
    )
}

fn read_u64(data: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("engine has repo parent")
        .to_path_buf()
}
