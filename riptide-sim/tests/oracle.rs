//! Proof that the [`riptide_sim::oracle`] Pyth `PriceUpdateV2` builder produces
//! bytes a consuming program actually reads.
//!
//! The builder writes the account; this test decodes it with an **independent**
//! Borsh decoder — a field-for-field mirror of
//! `pyth_solana_receiver_sdk::price_update::{PriceUpdateV2, PriceFeedMessage,
//! VerificationLevel}` (SDK 1.1.0) plus a replica of that SDK's
//! `get_price_no_older_than_with_custom_verification_level` checks — and reads
//! the price through it. Because the decoder is Borsh-sequential (it never
//! references the builder's offset constants), a layout bug in the builder
//! breaks the round-trip. A crashed price then flips a modeled liquidation from
//! "reject" to "trigger", proving the *price* bytes are read, not merely
//! constructed.
//!
//! The real SDK is not linked as a dev-dependency: `pythnet-sdk` (its transitive
//! `PriceFeedMessage` owner) pulls a conflicting Borsh major under this crate's
//! solana stack. The mirror below is the verification authority's layout,
//! re-derived against the cited SDK source.

use borsh::BorshDeserialize;

use riptide_sim::oracle::{
    crash_in_place, price_update_v2_discriminator, pyth_receiver_program, PythPriceUpdate,
};
use riptide_sim::World;

const FEED_ID: [u8; 32] = [0x11; 32];
const EXPO: i32 = -8;
const PUBLISH_TIME: i64 = 1_900_000_000;
const MAX_AGE: u64 = 3_600;

// Healthy collateral: 0.15 USD/token (price 15_000_000 at expo -8).
const HEALTHY_PRICE: i64 = 15_000_000;
// Modeled loan: 1000 collateral tokens backing a 100 USD debt.
const COLLATERAL_QTY: i128 = 1_000;
const DEBT_USD: i128 = 100;

// ---------------------------------------------------------------------------
// Independent SDK-layout mirror (cited to pyth-solana-receiver-sdk 1.1.0
// `src/price_update.rs` + pythnet-sdk 2.3.1 `src/messages.rs`).
// ---------------------------------------------------------------------------

#[derive(BorshDeserialize, PartialEq, Debug)]
enum VerificationLevel {
    Partial { num_signatures: u8 },
    Full,
}

impl VerificationLevel {
    // Mirror of the SDK's `VerificationLevel::gte`.
    fn gte(&self, other: &VerificationLevel) -> bool {
        match self {
            VerificationLevel::Full => true,
            VerificationLevel::Partial { num_signatures } => match other {
                VerificationLevel::Full => false,
                VerificationLevel::Partial {
                    num_signatures: other,
                } => num_signatures >= other,
            },
        }
    }
}

#[derive(BorshDeserialize)]
struct PriceFeedMessage {
    feed_id: [u8; 32],
    price: i64,
    #[allow(dead_code)]
    conf: u64,
    exponent: i32,
    publish_time: i64,
    #[allow(dead_code)]
    prev_publish_time: i64,
    #[allow(dead_code)]
    ema_price: i64,
    #[allow(dead_code)]
    ema_conf: u64,
}

#[derive(BorshDeserialize)]
struct PriceUpdateV2 {
    #[allow(dead_code)]
    write_authority: [u8; 32],
    verification_level: VerificationLevel,
    price_message: PriceFeedMessage,
    #[allow(dead_code)]
    posted_slot: u64,
}

/// Decode an account body the way an Anchor program does: validate the 8-byte
/// account discriminator, then Borsh-deserialize the remainder.
fn try_deserialize(data: &[u8]) -> Result<PriceUpdateV2, String> {
    if data.len() < 8 {
        return Err("account too short for discriminator".into());
    }
    if data[..8] != price_update_v2_discriminator() {
        return Err("discriminator mismatch".into());
    }
    PriceUpdateV2::try_from_slice(&data[8..]).map_err(|e| format!("borsh decode failed: {e}"))
}

/// Read the price back the way a consuming program does and decide whether a
/// loan is underwater. Mirrors the SDK's
/// `get_price_no_older_than_with_custom_verification_level` (verification + feed
/// + freshness checks). `Ok(true)` = liquidation triggers; `Ok(false)` = it
/// rejects; `Err` = the SDK read would have errored.
fn liquidation_would_trigger(data: &[u8], clock_unix_timestamp: i64) -> Result<bool, String> {
    let update = try_deserialize(data)?;
    if !update
        .verification_level
        .gte(&VerificationLevel::Partial { num_signatures: 1 })
    {
        return Err("insufficient verification level".into());
    }
    if update.price_message.feed_id != FEED_ID {
        return Err("mismatched feed id".into());
    }
    if update
        .price_message
        .publish_time
        .saturating_add(MAX_AGE as i64)
        < clock_unix_timestamp
    {
        return Err("price too old (freshness)".into());
    }
    let scale = 10i128.pow((-update.price_message.exponent) as u32);
    let collateral_scaled = update.price_message.price as i128 * COLLATERAL_QTY;
    let debt_scaled = DEBT_USD * scale;
    Ok(collateral_scaled < debt_scaled)
}

#[test]
fn oracle_crashed_price_flips_liquidation_from_reject_to_trigger() {
    let mut world = World::default();
    let key = solana_sdk::pubkey::Pubkey::new_unique();
    let clock_ts = PUBLISH_TIME + 1;

    // Install a healthy, fresh PriceUpdateV2; the decode must succeed AND the
    // loan must NOT be liquidatable at the healthy price (control).
    let update = PythPriceUpdate::new(FEED_ID, HEALTHY_PRICE, EXPO, PUBLISH_TIME);
    update.install(&mut world, key).unwrap();
    let healthy = world.get_account(&key).unwrap();
    assert_eq!(
        healthy.owner,
        pyth_receiver_program(),
        "account must be owned by the Pyth receiver so the program owner check passes"
    );
    assert!(
        !liquidation_would_trigger(&healthy.data, clock_ts).unwrap(),
        "healthy collateral price must reject liquidation (control)"
    );

    // Crash the collateral price in place (-50%); the same loan must now be
    // liquidatable — only possible if the new price bytes are read.
    crash_in_place(&mut world, &key, HEALTHY_PRICE / 2, PUBLISH_TIME).unwrap();
    let crashed = world.get_account(&key).unwrap();
    assert!(
        liquidation_would_trigger(&crashed.data, clock_ts).unwrap(),
        "crashed collateral price must trigger liquidation (proves the bytes are read)"
    );
}

#[test]
fn oracle_stale_publish_time_is_rejected_by_freshness_check() {
    // A price published far outside `MAX_AGE` of the clock must be rejected by
    // the freshness check — proving the publish_time bytes are read too.
    let mut world = World::default();
    let key = solana_sdk::pubkey::Pubkey::new_unique();
    let update = PythPriceUpdate::new(FEED_ID, HEALTHY_PRICE, EXPO, PUBLISH_TIME);
    update.install(&mut world, key).unwrap();
    let data = world.get_account(&key).unwrap().data;

    let stale_ts = PUBLISH_TIME + (MAX_AGE as i64) + 10;
    let err = liquidation_would_trigger(&data, stale_ts).unwrap_err();
    assert!(
        err.contains("price too old"),
        "stale price should be rejected by the freshness check, got: {err}"
    );
}

#[test]
fn oracle_builder_round_trips_through_the_independent_decoder() {
    // A full-field round-trip: every field the builder sets decodes back to the
    // same value through the Borsh mirror (catches any offset/width drift).
    let update = PythPriceUpdate::new(FEED_ID, HEALTHY_PRICE, EXPO, PUBLISH_TIME);
    let decoded = try_deserialize(&update.to_account_data()).unwrap();
    assert_eq!(
        decoded.verification_level,
        VerificationLevel::Partial { num_signatures: 1 }
    );
    assert_eq!(decoded.price_message.feed_id, FEED_ID);
    assert_eq!(decoded.price_message.price, HEALTHY_PRICE);
    assert_eq!(decoded.price_message.exponent, EXPO);
    assert_eq!(decoded.price_message.publish_time, PUBLISH_TIME);
}
