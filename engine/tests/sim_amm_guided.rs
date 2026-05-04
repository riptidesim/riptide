use std::path::PathBuf;

use anyhow::Result;
use solana_account::Account;
use solana_sdk::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
};

use riptide_sim::World;

const POOL_STATE_LEN: usize = 161;
const LP_POSITION_STATE_LEN: usize = 73;

#[test]
fn sim_amm_guided_flow_runs_without_engine_dispatcher_changes() -> Result<()> {
    let mut world = World::default();
    let program_id =
        world.load_program_from_so(repo_root().join("programs/amm/target/deploy/amm.so"))?;
    let pool = Pubkey::new_unique();
    let lp_position = Pubkey::new_unique();

    set_program_account(&mut world, pool, program_id, POOL_STATE_LEN)?;
    set_program_account(&mut world, lp_position, program_id, LP_POSITION_STATE_LEN)?;

    world.process_transaction(
        &[amm_ix(
            program_id,
            vec![
                AccountMeta::new_readonly(world.admin_pubkey(), true),
                AccountMeta::new(pool, false),
                AccountMeta::new(lp_position, false),
            ],
            &[0],
            &[1_000_000, 1_000_000, 30],
        )],
        Some("initialize_pool"),
    )?;

    world.process_transaction(
        &[
            amm_ix(
                program_id,
                vec![
                    AccountMeta::new_readonly(world.admin_pubkey(), true),
                    AccountMeta::new(pool, false),
                    AccountMeta::new(lp_position, false),
                ],
                &[1],
                &[100_000, 100_000],
            ),
            amm_ix(
                program_id,
                vec![
                    AccountMeta::new_readonly(world.admin_pubkey(), true),
                    AccountMeta::new(pool, false),
                ],
                &[3],
                &[10_000, 1, 0],
            ),
        ],
        Some("add_liquidity_and_swap"),
    )?;

    let pool_account = world.get_account(&pool).expect("pool account exists");
    let reserve_a = read_u64(&pool_account.data, 97);
    let reserve_b = read_u64(&pool_account.data, 105);
    let k_last = read_u64(&pool_account.data, 153);

    assert!(reserve_a > 1_000_000);
    assert!(reserve_b > 0);
    assert_eq!(k_last, reserve_a.saturating_mul(reserve_b));
    assert!(k_last >= 1_000_000_u64.saturating_mul(1_000_000));
    Ok(())
}

fn amm_ix(
    program_id: Pubkey,
    accounts: Vec<AccountMeta>,
    discriminator: &[u8],
    args: &[u64],
) -> Instruction {
    let mut data = discriminator.to_vec();
    for arg in args {
        data.extend(arg.to_le_bytes());
    }
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
