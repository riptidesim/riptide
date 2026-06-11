//! Deterministic external-oracle account builders for guided simulations.
//!
//! Credit-shaped protocols (lending, perps, IRS) read a price from an account
//! owned by an *external* program — most often a Pyth receiver
//! `PriceUpdateV2`. The program deserializes that account and calls
//! `get_price_no_older_than...(clock, max_age, feed_id)`. To stress such a
//! protocol the sim must place that account into the world with the exact bytes
//! the real receiver program would have written, then mutate the price between
//! lifecycle phases (the "crash"). The stress axis is the account's *contents*,
//! so those bytes have to be constructed and rewritten deterministically.
//!
//! Hand-rolling the bytes is error-prone: a guided run had to correct the
//! layout by hand (134-byte account, `VerificationLevel::Partial` encoded as
//! tag `0`). This module encodes the layout once, correct-by-construction, so a
//! generated sim crate never re-derives it.
//!
//! ## Pyth `PriceUpdateV2` byte layout
//!
//! Verified against `pyth-solana-receiver-sdk` 1.1.0
//! (`pyth_solana_receiver_sdk::price_update`):
//!
//! ```text
//! pub struct PriceUpdateV2 {            // Anchor account: 8-byte discriminator prefix
//!     pub write_authority: Pubkey,      // 32
//!     pub verification_level: VerificationLevel,
//!     pub price_message: PriceFeedMessage,
//!     pub posted_slot: u64,
//! }
//! pub enum VerificationLevel { Partial { num_signatures: u8 }, Full }  // Borsh tag: Partial = 0, Full = 1
//! pub struct PriceFeedMessage {
//!     pub feed_id: [u8; 32],
//!     pub price: i64,
//!     pub conf: u64,
//!     pub exponent: i32,
//!     pub publish_time: i64,
//!     pub prev_publish_time: i64,
//!     pub ema_price: i64,
//!     pub ema_conf: u64,
//! }
//! ```
//!
//! Anchor + Borsh serialize that, with `verification_level = Partial`, to a
//! fixed 134 bytes at these offsets:
//!
//! ```text
//!   0..8    Anchor discriminator  = sha256("account:PriceUpdateV2")[..8]
//!   8..40   write_authority (Pubkey)
//!   40      verification tag      = 0  (VerificationLevel::Partial)
//!   41      num_signatures (u8)        (Partial variant payload)
//!   42..74  feed_id ([u8; 32])
//!   74..82  price (i64, LE)
//!   82..90  conf (u64, LE)
//!   90..94  exponent (i32, LE)
//!   94..102 publish_time (i64, LE)
//!  102..110 prev_publish_time (i64, LE)
//!  110..118 ema_price (i64, LE)
//!  118..126 ema_conf (u64, LE)
//!  126..134 posted_slot (u64, LE)
//! ```

use std::str::FromStr;

use anyhow::Result;
use sha2::{Digest, Sha256};
use solana_account::Account;
use solana_sdk::pubkey::Pubkey;

use crate::World;

/// Base58 address of the Pyth Solana receiver program. `PriceUpdateV2` accounts
/// must be owned by it so the consuming program's `Account<'info,
/// PriceUpdateV2>` owner check passes.
pub const PYTH_RECEIVER_PROGRAM: &str = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";

/// Total serialized size of a `Partial`-verified `PriceUpdateV2`.
pub const PRICE_UPDATE_V2_LEN: usize = 134;

// Field offsets into the serialized account (see module docs).
const OFF_DISCRIMINATOR: usize = 0;
const OFF_WRITE_AUTHORITY: usize = 8;
const OFF_VERIFICATION_TAG: usize = 40;
const OFF_NUM_SIGNATURES: usize = 41;
const OFF_FEED_ID: usize = 42;
const OFF_PRICE: usize = 74;
const OFF_CONF: usize = 82;
const OFF_EXPONENT: usize = 90;
const OFF_PUBLISH_TIME: usize = 94;
const OFF_PREV_PUBLISH_TIME: usize = 102;
const OFF_EMA_PRICE: usize = 110;
const OFF_EMA_CONF: usize = 118;
const OFF_POSTED_SLOT: usize = 126;

/// `VerificationLevel::Partial` Borsh tag (the receiver writes `Partial` for the
/// common single-update path; `Full` is tag `1`).
const VERIFICATION_PARTIAL_TAG: u8 = 0;

/// Lamports parked on the synthesized account (rent-exempt-ish; the consuming
/// program never debits it).
const DEFAULT_LAMPORTS: u64 = 5_000_000;

/// The Anchor account discriminator for `PriceUpdateV2`:
/// `sha256("account:PriceUpdateV2")[..8]`. Computed rather than hardcoded so it
/// can never silently drift from the SDK's `#[account]`-derived value.
pub fn price_update_v2_discriminator() -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(b"account:PriceUpdateV2");
    let digest = hasher.finalize();
    let mut out = [0u8; 8];
    out.copy_from_slice(&digest[..8]);
    out
}

/// The Pyth receiver program id as a [`Pubkey`].
pub fn pyth_receiver_program() -> Pubkey {
    Pubkey::from_str(PYTH_RECEIVER_PROGRAM).expect("valid Pyth receiver program id literal")
}

/// A deterministic, mutable Pyth `PriceUpdateV2` an in-sim program reads.
///
/// Construct with [`PythPriceUpdate::new`], shape the price path with
/// [`set_price`](Self::set_price) / [`crash_price`](Self::crash_price) and the
/// publish time with [`set_publish_time`](Self::set_publish_time) /
/// [`fresh_for_clock`](Self::fresh_for_clock), then install it into the
/// [`World`] with [`install`](Self::install). Rewrite the price in place
/// between lifecycle phases with [`crash_in_place`](Self::crash_in_place).
#[derive(Debug, Clone)]
pub struct PythPriceUpdate {
    pub write_authority: Pubkey,
    pub num_signatures: u8,
    pub feed_id: [u8; 32],
    pub price: i64,
    pub conf: u64,
    pub exponent: i32,
    pub publish_time: i64,
    pub prev_publish_time: i64,
    pub ema_price: i64,
    pub ema_conf: u64,
    pub posted_slot: u64,
}

impl PythPriceUpdate {
    /// A `Partial`-verified update for `feed_id` at `price` (with `exponent`,
    /// e.g. `-8`) published at `publish_time`. Defaults mirror a single fresh
    /// update: `num_signatures = 1`, `conf = 0`, `prev_publish_time =
    /// publish_time`, `ema_price = price`, `ema_conf = 0`, `posted_slot = 1`,
    /// `write_authority = default`. Adjust any field before installing.
    pub fn new(feed_id: [u8; 32], price: i64, exponent: i32, publish_time: i64) -> Self {
        Self {
            write_authority: Pubkey::default(),
            num_signatures: 1,
            feed_id,
            price,
            conf: 0,
            exponent,
            publish_time,
            prev_publish_time: publish_time,
            ema_price: price,
            ema_conf: 0,
            posted_slot: 1,
        }
    }

    /// Set the spot price, keeping the EMA price aligned with it (the common
    /// case where a single update moves both).
    pub fn set_price(&mut self, price: i64) -> &mut Self {
        self.price = price;
        self.ema_price = price;
        self
    }

    /// Drop the price by `drop_bps` basis points (10_000 bps = 100%) — the
    /// collateral "crash". Saturates at zero. Leaves `publish_time` untouched;
    /// pair with [`set_publish_time`](Self::set_publish_time) when the crash
    /// should also re-stamp freshness.
    pub fn crash_price(&mut self, drop_bps: u64) -> &mut Self {
        let drop_bps = drop_bps.min(10_000) as i128;
        let crashed = (self.price as i128) * (10_000 - drop_bps) / 10_000;
        self.set_price(crashed as i64);
        self
    }

    /// Set the publish time (the value the program's
    /// `get_price_no_older_than(clock, max_age, feed_id)` checks against the sim
    /// clock: the read succeeds while `publish_time + max_age >=
    /// clock.unix_timestamp`).
    pub fn set_publish_time(&mut self, publish_time: i64) -> &mut Self {
        self.publish_time = publish_time;
        self
    }

    /// Stamp the update as freshly published at the sim clock's current unix
    /// timestamp, so any non-negative `max_age` passes the freshness check.
    pub fn fresh_for_clock(&mut self, clock_unix_timestamp: i64) -> &mut Self {
        self.publish_time = clock_unix_timestamp;
        self
    }

    /// Serialize to the exact 134 bytes the Pyth receiver would write.
    pub fn to_account_data(&self) -> Vec<u8> {
        let mut data = vec![0u8; PRICE_UPDATE_V2_LEN];
        data[OFF_DISCRIMINATOR..OFF_DISCRIMINATOR + 8]
            .copy_from_slice(&price_update_v2_discriminator());
        data[OFF_WRITE_AUTHORITY..OFF_WRITE_AUTHORITY + 32]
            .copy_from_slice(self.write_authority.as_ref());
        data[OFF_VERIFICATION_TAG] = VERIFICATION_PARTIAL_TAG;
        data[OFF_NUM_SIGNATURES] = self.num_signatures;
        data[OFF_FEED_ID..OFF_FEED_ID + 32].copy_from_slice(&self.feed_id);
        data[OFF_PRICE..OFF_PRICE + 8].copy_from_slice(&self.price.to_le_bytes());
        data[OFF_CONF..OFF_CONF + 8].copy_from_slice(&self.conf.to_le_bytes());
        data[OFF_EXPONENT..OFF_EXPONENT + 4].copy_from_slice(&self.exponent.to_le_bytes());
        data[OFF_PUBLISH_TIME..OFF_PUBLISH_TIME + 8]
            .copy_from_slice(&self.publish_time.to_le_bytes());
        data[OFF_PREV_PUBLISH_TIME..OFF_PREV_PUBLISH_TIME + 8]
            .copy_from_slice(&self.prev_publish_time.to_le_bytes());
        data[OFF_EMA_PRICE..OFF_EMA_PRICE + 8].copy_from_slice(&self.ema_price.to_le_bytes());
        data[OFF_EMA_CONF..OFF_EMA_CONF + 8].copy_from_slice(&self.ema_conf.to_le_bytes());
        data[OFF_POSTED_SLOT..OFF_POSTED_SLOT + 8].copy_from_slice(&self.posted_slot.to_le_bytes());
        data
    }

    /// The full account (owner = Pyth receiver) ready for `World::set_account`.
    pub fn account(&self) -> Account {
        Account {
            lamports: DEFAULT_LAMPORTS,
            data: self.to_account_data(),
            owner: pyth_receiver_program(),
            ..Default::default()
        }
    }

    /// Install the account at `key` in the world (owner = Pyth receiver).
    pub fn install(&self, world: &mut World, key: Pubkey) -> Result<()> {
        world.set_account(key, self.account())
    }
}

/// Rewrite the price (and publish time) of an already-installed
/// `PriceUpdateV2` in place — the cheap mid-lifecycle "crash" mutation that does
/// not rebuild the account. Updates `price` and `ema_price` to `new_price` and
/// re-stamps `publish_time`. No-op if the account is missing or too short.
pub fn crash_in_place(
    world: &mut World,
    key: &Pubkey,
    new_price: i64,
    publish_time: i64,
) -> Result<()> {
    world.mutate_account(key, |account| {
        if account.data.len() >= PRICE_UPDATE_V2_LEN {
            account.data[OFF_PRICE..OFF_PRICE + 8].copy_from_slice(&new_price.to_le_bytes());
            account.data[OFF_EMA_PRICE..OFF_EMA_PRICE + 8]
                .copy_from_slice(&new_price.to_le_bytes());
            account.data[OFF_PUBLISH_TIME..OFF_PUBLISH_TIME + 8]
                .copy_from_slice(&publish_time.to_le_bytes());
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // The byte-layout proof lives in `tests/oracle.rs`, where the helper's
    // output is deserialized by the real `pyth-solana-receiver-sdk` and drives a
    // price read. These unit tests pin the layout constants the SDK proof relies
    // on, so a layout regression fails fast and locally.

    #[test]
    fn discriminator_matches_anchor_account_hash() {
        // The hand-verified Anchor discriminator for `PriceUpdateV2` the guided
        // runs used; recomputing from the name must reproduce it exactly.
        assert_eq!(
            price_update_v2_discriminator(),
            [34, 241, 35, 99, 157, 126, 244, 205]
        );
    }

    #[test]
    fn serialized_account_is_134_bytes_partial_tagged() {
        let update = PythPriceUpdate::new([0x11; 32], 15_000_000, -8, 1_900_000_000);
        let data = update.to_account_data();
        assert_eq!(data.len(), PRICE_UPDATE_V2_LEN);
        assert_eq!(data[OFF_VERIFICATION_TAG], VERIFICATION_PARTIAL_TAG);
        assert_eq!(data[OFF_NUM_SIGNATURES], 1);
        assert_eq!(&data[OFF_FEED_ID..OFF_FEED_ID + 32], &[0x11; 32]);
        assert_eq!(
            i64::from_le_bytes(data[OFF_PRICE..OFF_PRICE + 8].try_into().unwrap()),
            15_000_000
        );
    }

    #[test]
    fn crash_price_drops_by_basis_points() {
        let mut update = PythPriceUpdate::new([0x11; 32], 15_000_000, -8, 1_900_000_000);
        update.crash_price(4_000); // -40%
        assert_eq!(update.price, 9_000_000);
        assert_eq!(update.ema_price, 9_000_000);
    }
}
