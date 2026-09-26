//! Firing Check: prove an invariant can fail by injecting a known violation.
//!
//! A sim declares one [`FiringCheck`] per invariant through its
//! `#[violations]` method. In firing-check mode the runner reaches the end of
//! one fixed-seed iteration, applies each declared [`Violation`] in turn, and
//! reports whether the named invariant fired because of it.

use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use solana_sdk::pubkey::Pubkey;

use crate::World;

/// Byte offset of the `amount` field in an SPL token account.
const SPL_TOKEN_AMOUNT_OFFSET: usize = 64;

/// A custom injection into the World.
pub type Injection = Box<dyn Fn(&mut World) -> Result<()>>;

/// The violation a Firing Check injects into the World before the end-of-run
/// invariant check.
pub enum Violation {
    /// Zero `width` little-endian bytes at `offset` of `account`, such as a
    /// borrower's collateral.
    ZeroField {
        account: Pubkey,
        offset: usize,
        width: usize,
    },
    /// Drop a Pyth `PriceUpdateV2` price by `drop_bps` basis points.
    PerturbPythPrice { account: Pubkey, drop_bps: u64 },
    /// Undo an SPL token transfer of `amount` from `source` to `destination`,
    /// as if the flow had skipped it.
    SkipTransfer {
        source: Pubkey,
        destination: Pubkey,
        amount: u64,
    },
    /// Any other injection, described for the report.
    Custom {
        description: String,
        apply: Injection,
    },
}

impl Violation {
    pub fn zero_field(account: Pubkey, offset: usize, width: usize) -> Self {
        Self::ZeroField {
            account,
            offset,
            width,
        }
    }

    pub fn perturb_pyth_price(account: Pubkey, drop_bps: u64) -> Self {
        Self::PerturbPythPrice { account, drop_bps }
    }

    pub fn skip_transfer(source: Pubkey, destination: Pubkey, amount: u64) -> Self {
        Self::SkipTransfer {
            source,
            destination,
            amount,
        }
    }

    pub fn custom(
        description: impl Into<String>,
        apply: impl Fn(&mut World) -> Result<()> + 'static,
    ) -> Self {
        Self::Custom {
            description: description.into(),
            apply: Box::new(apply),
        }
    }

    pub fn describe(&self) -> String {
        match self {
            Self::ZeroField {
                account,
                offset,
                width,
            } => format!("zero {width} byte(s) at offset {offset} of {account}"),
            Self::PerturbPythPrice { account, drop_bps } => {
                format!("drop the Pyth price of {account} by {drop_bps} bps")
            }
            Self::SkipTransfer {
                source,
                destination,
                amount,
            } => format!("skip the transfer of {amount} from {source} to {destination}"),
            Self::Custom { description, .. } => description.clone(),
        }
    }

    pub fn apply(&self, world: &mut World) -> Result<()> {
        match self {
            Self::ZeroField {
                account,
                offset,
                width,
            } => {
                let end = offset
                    .checked_add(*width)
                    .ok_or_else(|| anyhow!("field range overflows"))?;
                let mut data = account_data(world, account)?;
                let field = data.get_mut(*offset..end).ok_or_else(|| {
                    anyhow!("account {account} has no bytes {offset}..{end} to zero")
                })?;
                field.fill(0);
                write_data(world, account, data)
            }
            Self::PerturbPythPrice { account, drop_bps } => {
                crate::oracle::perturb_price_in_place(world, account, *drop_bps)
            }
            Self::SkipTransfer {
                source,
                destination,
                amount,
            } => {
                let destination_amount = read_token_amount(world, destination)?
                    .checked_sub(*amount)
                    .ok_or_else(|| anyhow!("{destination} holds less than {amount}"))?;
                let source_amount = read_token_amount(world, source)?
                    .checked_add(*amount)
                    .ok_or_else(|| anyhow!("{source} amount overflows"))?;
                write_token_amount(world, destination, destination_amount)?;
                write_token_amount(world, source, source_amount)
            }
            Self::Custom { apply, .. } => apply(world),
        }
    }
}

/// One invariant's declared violation.
pub struct FiringCheck {
    pub invariant: String,
    pub violation: Violation,
}

impl FiringCheck {
    pub fn new(invariant: impl Into<String>, violation: Violation) -> Self {
        Self {
            invariant: invariant.into(),
            violation,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FiringResult {
    Fired,
    DidNotFire,
}

/// The outcome of one invariant's Firing Check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FiringCheckOutcome {
    pub invariant: String,
    pub violation: String,
    pub result: FiringResult,
    /// Why an invariant did not fire, when the runner can tell.
    pub detail: Option<String>,
}

/// Every declared invariant's outcome for one seed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FiringCheckReport {
    pub seed: String,
    pub flows_per_iteration: u64,
    pub invariants: Vec<FiringCheckOutcome>,
}

fn account_data(world: &World, account: &Pubkey) -> Result<Vec<u8>> {
    world
        .get_account(account)
        .map(|account| account.data)
        .ok_or_else(|| anyhow!("account {account} is missing"))
}

fn write_data(world: &mut World, account: &Pubkey, data: Vec<u8>) -> Result<()> {
    world.mutate_account(account, |stored| stored.data = data)
}

fn read_token_amount(world: &World, account: &Pubkey) -> Result<u64> {
    let data = account_data(world, account)?;
    let bytes = data
        .get(SPL_TOKEN_AMOUNT_OFFSET..SPL_TOKEN_AMOUNT_OFFSET + 8)
        .ok_or_else(|| anyhow!("account {account} is not an SPL token account"))?;
    let mut amount = [0u8; 8];
    amount.copy_from_slice(bytes);
    Ok(u64::from_le_bytes(amount))
}

fn write_token_amount(world: &mut World, account: &Pubkey, amount: u64) -> Result<()> {
    let mut data = account_data(world, account)?;
    let Some(field) = data.get_mut(SPL_TOKEN_AMOUNT_OFFSET..SPL_TOKEN_AMOUNT_OFFSET + 8) else {
        bail!("account {account} is not an SPL token account");
    };
    field.copy_from_slice(&amount.to_le_bytes());
    write_data(world, account, data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_account::Account;

    fn world_with(account: Pubkey, data: Vec<u8>) -> World {
        let mut world = World::new(Pubkey::new_unique());
        world
            .set_account(
                account,
                Account {
                    lamports: 1_000_000,
                    data,
                    owner: Pubkey::new_unique(),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        world
    }

    #[test]
    fn zero_field_zeroes_only_the_declared_bytes() {
        let account = Pubkey::new_unique();
        let mut world = world_with(account, vec![0xff; 12]);
        Violation::zero_field(account, 4, 4)
            .apply(&mut world)
            .unwrap();
        let data = world.get_account(&account).unwrap().data;
        assert_eq!(
            data,
            [0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]
        );
    }

    #[test]
    fn zero_field_out_of_range_or_missing_account_is_an_error() {
        let account = Pubkey::new_unique();
        let mut world = world_with(account, vec![1; 4]);
        assert!(Violation::zero_field(account, 2, 8)
            .apply(&mut world)
            .is_err());
        assert!(Violation::zero_field(Pubkey::new_unique(), 0, 1)
            .apply(&mut world)
            .is_err());
    }

    #[test]
    fn perturb_pyth_price_drops_the_installed_price() {
        use crate::oracle::PythPriceUpdate;

        let oracle = Pubkey::new_unique();
        let mut world = World::new(Pubkey::new_unique());
        PythPriceUpdate::new([0x11; 32], 15_000_000, -8, 1_900_000_000)
            .install(&mut world, oracle)
            .unwrap();
        Violation::perturb_pyth_price(oracle, 4_000)
            .apply(&mut world)
            .unwrap();
        let data = world.get_account(&oracle).unwrap().data;
        assert_eq!(
            i64::from_le_bytes(data[74..82].try_into().unwrap()),
            9_000_000
        );

        let short = Pubkey::new_unique();
        let mut world = world_with(short, vec![0; 16]);
        assert!(Violation::perturb_pyth_price(short, 100)
            .apply(&mut world)
            .is_err());
    }

    #[test]
    fn skip_transfer_moves_the_amount_back() {
        let source = Pubkey::new_unique();
        let destination = Pubkey::new_unique();
        let mut data = vec![0u8; 165];
        data[64..72].copy_from_slice(&100u64.to_le_bytes());
        let mut world = world_with(source, data.clone());
        data[64..72].copy_from_slice(&40u64.to_le_bytes());
        world
            .set_account(
                destination,
                Account {
                    lamports: 1_000_000,
                    data,
                    owner: Pubkey::new_unique(),
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();

        Violation::skip_transfer(source, destination, 30)
            .apply(&mut world)
            .unwrap();
        assert_eq!(read_token_amount(&world, &source).unwrap(), 130);
        assert_eq!(read_token_amount(&world, &destination).unwrap(), 10);

        assert!(Violation::skip_transfer(source, destination, 11)
            .apply(&mut world)
            .is_err());
    }
}
