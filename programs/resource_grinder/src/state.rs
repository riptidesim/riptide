use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

use crate::error::ResourceGrinderError;

pub const PLAYER_STATE_LEN: usize = 48;
pub const MARKETPLACE_STATE_LEN: usize = 512;

pub const MINE_DISCRIMINATOR: [u8; 8] = [109, 105, 110, 101, 0, 0, 0, 0];
pub const CRAFT_DISCRIMINATOR: [u8; 8] = [99, 114, 97, 102, 116, 0, 0, 0];
pub const LIST_FOR_SALE_DISCRIMINATOR: [u8; 8] = [108, 105, 115, 116, 115, 97, 108, 101];

#[derive(Debug, Clone, PartialEq, Eq, Default, BorshSerialize, BorshDeserialize)]
pub struct PlayerState {
    pub owner: [u8; 32],
    pub gold: u64,
    pub wood: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Listing {
    pub seller: [u8; 32],
    pub amount: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, BorshSerialize, BorshDeserialize)]
pub struct MarketplaceState {
    pub listings: Vec<Listing>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceGrinderInstruction {
    Mine { amount: u64 },
    Craft { amount: u64 },
    ListForSale { amount: u64 },
}

impl PlayerState {
    pub fn owner_pubkey(&self) -> Pubkey {
        Pubkey::new_from_array(self.owner)
    }

    pub fn is_uninitialized(&self) -> bool {
        self.owner == [0; 32] && self.gold == 0 && self.wood == 0
    }
}

impl ResourceGrinderInstruction {
    pub fn decode(data: &[u8]) -> Result<Self, ResourceGrinderError> {
        let (discriminator, payload) = data
            .split_first_chunk::<8>()
            .ok_or(ResourceGrinderError::InvalidAccountData)?;

        let amount = decode_amount(payload)?;
        match *discriminator {
            MINE_DISCRIMINATOR => Ok(Self::Mine { amount }),
            CRAFT_DISCRIMINATOR => Ok(Self::Craft { amount }),
            LIST_FOR_SALE_DISCRIMINATOR => Ok(Self::ListForSale { amount }),
            _ => Err(ResourceGrinderError::InvalidAccountData),
        }
    }
}

fn decode_amount(data: &[u8]) -> Result<u64, ResourceGrinderError> {
    let bytes: [u8; 8] = data
        .try_into()
        .map_err(|_| ResourceGrinderError::InvalidAccountData)?;
    Ok(u64::from_le_bytes(bytes))
}
