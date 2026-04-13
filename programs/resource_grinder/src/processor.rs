use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
};

use crate::{
    error::ResourceGrinderError,
    state::{MarketplaceState, PlayerState, ResourceGrinderInstruction},
};

pub struct Processor;

impl Processor {
    pub fn process(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        instruction_data: &[u8],
    ) -> Result<(), ProgramError> {
        let instruction = ResourceGrinderInstruction::decode(instruction_data)?;
        let accounts_iter = &mut accounts.iter();

        match instruction {
            ResourceGrinderInstruction::Mine { amount } => {
                let authority = next_account_info(accounts_iter)?;
                let player = next_account_info(accounts_iter)?;
                Self::require_signer(authority)?;
                Self::assert_program_account(player, program_id)?;

                let mut player_state: PlayerState = Self::read_state(player)?;
                Self::claim_or_check_owner(&mut player_state, authority.key)?;
                player_state.wood = player_state
                    .wood
                    .checked_add(amount)
                    .ok_or(ResourceGrinderError::InvalidAccountData)?;
                Self::write_state(player, &player_state)?;
                msg!("mine amount={} wood={}", amount, player_state.wood);
                Ok(())
            }
            ResourceGrinderInstruction::Craft { amount } => {
                let authority = next_account_info(accounts_iter)?;
                let player = next_account_info(accounts_iter)?;
                Self::require_signer(authority)?;
                Self::assert_program_account(player, program_id)?;

                let mut player_state: PlayerState = Self::read_state(player)?;
                Self::claim_or_check_owner(&mut player_state, authority.key)?;
                if player_state.wood < amount {
                    return Err(ResourceGrinderError::InsufficientWood.into());
                }
                player_state.wood = player_state
                    .wood
                    .checked_sub(amount)
                    .ok_or(ResourceGrinderError::InvalidAccountData)?;
                player_state.gold = player_state
                    .gold
                    .checked_add(amount)
                    .ok_or(ResourceGrinderError::InvalidAccountData)?;
                Self::write_state(player, &player_state)?;
                msg!(
                    "craft amount={} gold={} wood={}",
                    amount,
                    player_state.gold,
                    player_state.wood
                );
                Ok(())
            }
            ResourceGrinderInstruction::ListForSale { amount } => {
                let authority = next_account_info(accounts_iter)?;
                let player = next_account_info(accounts_iter)?;
                let marketplace = next_account_info(accounts_iter)?;
                Self::require_signer(authority)?;
                Self::assert_program_account(player, program_id)?;
                Self::assert_program_account(marketplace, program_id)?;

                let mut player_state: PlayerState = Self::read_state(player)?;
                Self::claim_or_check_owner(&mut player_state, authority.key)?;
                let mut marketplace_state: MarketplaceState = Self::read_state(marketplace)?;

                if let Some(listing) = marketplace_state
                    .listings
                    .iter_mut()
                    .find(|listing| listing.seller == authority.key.to_bytes())
                {
                    listing.amount = listing
                        .amount
                        .checked_add(amount)
                        .ok_or(ResourceGrinderError::InvalidAccountData)?;
                } else {
                    marketplace_state.listings.push(crate::state::Listing {
                        seller: authority.key.to_bytes(),
                        amount,
                    });
                }

                Self::write_state(marketplace, &marketplace_state)?;
                msg!(
                    "list_for_sale amount={} sellers={}",
                    amount,
                    marketplace_state.listings.len()
                );
                Ok(())
            }
        }
    }

    fn require_signer(account: &AccountInfo) -> Result<(), ProgramError> {
        if !account.is_signer {
            return Err(ResourceGrinderError::Unauthorized.into());
        }
        Ok(())
    }

    fn assert_program_account(
        account: &AccountInfo,
        program_id: &Pubkey,
    ) -> Result<(), ProgramError> {
        if account.owner != program_id {
            return Err(ResourceGrinderError::InvalidAccountOwner.into());
        }
        Ok(())
    }

    fn claim_or_check_owner(
        player_state: &mut PlayerState,
        authority: &Pubkey,
    ) -> Result<(), ProgramError> {
        if player_state.is_uninitialized() {
            player_state.owner = authority.to_bytes();
            return Ok(());
        }
        if player_state.owner_pubkey() != *authority {
            return Err(ResourceGrinderError::Unauthorized.into());
        }
        Ok(())
    }

    fn read_state<T: BorshDeserialize>(account: &AccountInfo) -> Result<T, ProgramError> {
        let data = account.data.borrow();
        let mut slice: &[u8] = &data;
        T::deserialize(&mut slice).map_err(|_| ResourceGrinderError::InvalidAccountData.into())
    }

    fn write_state<T: BorshSerialize>(
        account: &AccountInfo,
        state: &T,
    ) -> Result<(), ProgramError> {
        let encoded = state
            .try_to_vec()
            .map_err(|_| ResourceGrinderError::InvalidAccountData)?;
        let mut data = account.data.borrow_mut();
        if encoded.len() > data.len() {
            return Err(ResourceGrinderError::InvalidAccountData.into());
        }
        data.fill(0);
        data[..encoded.len()].copy_from_slice(&encoded);
        Ok(())
    }
}
