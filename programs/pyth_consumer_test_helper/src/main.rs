//! Real `pyth-sdk-solana` consumer helper.
//!
//! Reads a 3312-byte `SolanaPriceAccount` buffer from stdin, parses it
//! via `pyth_sdk_solana::state::load_price_account::<32, ()>` (the
//! exact same path `load_price_feed_from_account_info` takes after it
//! borrows the account data), and emits a one-line JSON blob on
//! stdout:
//!
//! ```json
//! {
//! "magic": 0xa1b2c3d4,
//! "version": 2,
//! "account_type": 3,
//! "expo": -2,
//! "price": 12345,
//! "conf": 0,
//! "status": "Trading",
//! "publish_slot": 0,
//! "ema_price": 12345
//! }
//! ```
//!
//! A parse failure is printed to stderr and the process exits 2 so
//! the engine test can distinguish "invalid bytes" from "parse OK but
//! values drifted". Stderr is never mixed into the JSON channel.
//!
//! This crate is intentionally outside the main Riptide workspace —
//! `pyth-sdk-solana` pulls `borsh 0.10.4` which conflicts with the
//! engine's pinned `borsh 1.6.1`, so the only way to run the real SDK
//! against a modern engine is to quarantine its dep tree here.
//!
//! Build with `cargo build --manifest-path
//! programs/pyth_consumer_test_helper/Cargo.toml`. The engine's t23 test will
//! find the binary at the standard cargo output path.

use std::io::Read;

use pyth_sdk_solana::state::{load_price_account, SolanaPriceAccount};
use serde_json::json;

fn main() {
    let mut buf = Vec::new();
    if let Err(e) = std::io::stdin().read_to_end(&mut buf) {
        eprintln!("pyth-consumer-test-helper: stdin read failed: {e}");
        std::process::exit(2);
    }

    // mock encodes exactly 3312 bytes — enforce the floor
    // so a short buffer is a clear protocol error rather than an
    // undefined-read.
    let expected = std::mem::size_of::<SolanaPriceAccount>();
    if buf.len() < expected {
        eprintln!(
            "pyth-consumer-test-helper: stdin too short: got {} bytes, expected >= {}",
            buf.len(),
            expected
        );
        std::process::exit(2);
    }

    // load_price_account runs the real `pyth-sdk-solana` validation:
    // - `magic == 0xa1b2c3d4`
    // - `ver == 2`
    // - `atype == 3 (Price)`
    // - `buf.len() >= size_of::<SolanaPriceAccount>()`
    //
    // This is the exact same code path
    // `load_price_feed_from_account_info` takes after it borrows the
    // AccountInfo's data — so if this succeeds, any on-chain Pyth
    // program reading our mock also succeeds.
    let account: &SolanaPriceAccount = match load_price_account::<32, ()>(&buf) {
        Ok(acc) => acc,
        Err(e) => {
            eprintln!("pyth-consumer-test-helper: load_price_account rejected bytes: {e:?}");
            std::process::exit(2);
        }
    };

    let status_str = format!("{:?}", account.agg.status);
    let out = json!({
        "magic": account.magic,
        "version": account.ver,
        "account_type": account.atype,
        "expo": account.expo,
        "price": account.agg.price,
        "conf": account.agg.conf,
        "status": status_str,
        "publish_slot": account.agg.pub_slot,
        "ema_price": account.ema_price.val,
    });

    println!("{}", out);
}
