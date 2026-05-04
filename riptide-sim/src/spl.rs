// Adapted from Trident (MIT) — https://github.com/Ackee-Blockchain/trident

use std::str::FromStr;

use solana_sdk::pubkey::Pubkey;

const SPL_TOKEN_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SPL_TOKEN_2022_PROGRAM_ID: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnB8qtgK7dizv3";

pub fn token_program_id() -> Pubkey {
    Pubkey::from_str(SPL_TOKEN_PROGRAM_ID).expect("SPL token program id is valid")
}

pub fn token_2022_program_id() -> Pubkey {
    Pubkey::from_str(SPL_TOKEN_2022_PROGRAM_ID).expect("Token-2022 program id is valid")
}

pub fn spl_mint_data(mint_authority: Pubkey, supply: u64, decimals: u8) -> Vec<u8> {
    let mut data = vec![0u8; 82];
    data[0..4].copy_from_slice(&1u32.to_le_bytes());
    data[4..36].copy_from_slice(mint_authority.as_ref());
    data[36..44].copy_from_slice(&supply.to_le_bytes());
    data[44] = decimals;
    data[45] = 1;
    data
}

pub fn spl_token_2022_mint_data(mint_authority: Pubkey, supply: u64, decimals: u8) -> Vec<u8> {
    spl_mint_data(mint_authority, supply, decimals)
}

pub fn spl_token_account_data(mint: Pubkey, authority: Pubkey, amount: u64) -> Vec<u8> {
    let mut data = vec![0u8; 165];
    data[0..32].copy_from_slice(mint.as_ref());
    data[32..64].copy_from_slice(authority.as_ref());
    data[64..72].copy_from_slice(&amount.to_le_bytes());
    data[108] = 1;
    data
}
