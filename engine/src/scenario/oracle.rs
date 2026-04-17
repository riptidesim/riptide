use anyhow::{anyhow, Result};
use borsh::{BorshDeserialize, BorshSerialize};

use crate::adapter::OracleKind;

/// Engine-side mirror of the on-chain oracle account layout.
///
/// **SSOT note:** this struct is a byte-for-byte Borsh mirror
/// of `programs/lending_pool::state::OracleState`. The two crates live in
/// separate Cargo workspaces pinned to incompatible `borsh` versions
/// (engine: 1.6, on-chain program: 0.10), so the shared-crate extraction
/// the spec suggests is not feasible without unifying the on-chain
/// `borsh`/`solana-program` pins (which would break the SBF build).
///
/// Enforcement is instead anchored to `fixtures/oracle_state_golden.bin`,
/// which both sides round-trip against in unit tests. A field change on
/// either side will break that side's `oracle_snapshot_matches_golden_bytes`
/// test. When the layout genuinely changes, regenerate the golden file and
/// update both tests in lock-step.
#[derive(Debug, Clone, PartialEq, BorshSerialize, BorshDeserialize)]
pub struct OracleSnapshot {
    pub is_initialized: bool,
    pub admin: [u8; 32],
    pub price: u64,
    pub exponent: i8,
    pub reserved: [u8; 8],
}

#[derive(Debug, Clone, PartialEq)]
pub struct OracleUpdate {
    pub price: f64,
    pub exponent: i8,
}

impl OracleUpdate {
    pub fn as_u64(&self) -> u64 {
        let normalized_price = self.price.max(0.0);
        if self.exponent < 0 {
            let scale = 10f64.powi(i32::from(-self.exponent));
            (normalized_price * scale).round() as u64
        } else {
            let scale = 10f64.powi(i32::from(self.exponent));
            (normalized_price / scale).round() as u64
        }
    }
}

pub fn decode_oracle(bytes: &[u8]) -> Result<OracleSnapshot> {
    OracleSnapshot::try_from_slice(bytes).map_err(|error| anyhow!(error))
}

// ---------------------------------------------------------------------------
// Sprint 5 T05 — Generic oracle injection dispatch
// ---------------------------------------------------------------------------
//
// The legacy path (kept above) is the admin-mock-shaped
// `OracleSnapshot` the Solend-fork lending primitive writes directly
// through its harness. The dispatch layer below adds a single entry
// point the engine uses when an adapter's `[[oracles]]` block declares
// a non-implicit oracle kind. The Solend hero grid does not go through
// this path (it keeps writing `OracleSnapshot` bytes via the harness
// directly), so the Sprint 4 determinism hash stays byte-stable.

/// Account layout contract every concrete oracle kind implements.
///
/// The engine calls `encode` to produce a byte blob it can drop onto a
/// program-owned account, and `decode` to verify what the program saw.
/// Round-trip equality on (price, exponent) must hold for every kind.
pub trait OracleLayout: Send + Sync {
    /// Stable byte length this layout serializes to. Used by the
    /// engine to validate adapter account space declarations before
    /// booting the program.
    fn byte_len(&self) -> usize;
    /// Serialize an admin-owned price update to raw account bytes.
    fn encode(&self, admin: [u8; 32], update: &OracleUpdate) -> Result<Vec<u8>>;
    /// Decode account bytes back into a normalized update for
    /// verification / invariant checks.
    fn decode(&self, bytes: &[u8]) -> Result<OracleUpdate>;
}

/// Resolve the layout implementation for a declared oracle kind.
pub fn oracle_layout_for(kind: OracleKind) -> Box<dyn OracleLayout> {
    match kind {
        OracleKind::AdminMock => Box::new(AdminMockOracleLayout),
        OracleKind::Pyth => Box::new(PythMockOracleLayout),
    }
}

/// Admin-mock account layout. Byte-identical to the legacy
/// `OracleSnapshot` so adapters that declare
/// `kind = "admin-mock"` point at the same on-chain bytes Sprint 4's
/// Solend-fork grid already writes. This is the shipping oracle kind
/// for Sprint 5 — T07 (perps-fork) reads from it.
pub struct AdminMockOracleLayout;

impl OracleLayout for AdminMockOracleLayout {
    fn byte_len(&self) -> usize {
        // is_initialized (1) + admin (32) + price (8) + exponent (1) + reserved (8) = 50
        50
    }
    fn encode(&self, admin: [u8; 32], update: &OracleUpdate) -> Result<Vec<u8>> {
        let snapshot = OracleSnapshot {
            is_initialized: true,
            admin,
            price: update.as_u64(),
            exponent: update.exponent,
            reserved: [0; 8],
        };
        borsh::to_vec(&snapshot).map_err(|e| anyhow!(e))
    }
    fn decode(&self, bytes: &[u8]) -> Result<OracleUpdate> {
        let snapshot = decode_oracle(bytes)?;
        let scale = 10f64.powi(i32::from(-snapshot.exponent));
        let price = if snapshot.exponent < 0 {
            snapshot.price as f64 / scale
        } else {
            snapshot.price as f64 * 10f64.powi(i32::from(snapshot.exponent))
        };
        Ok(OracleUpdate {
            price,
            exponent: snapshot.exponent,
        })
    }
}

/// Pyth-compatible mock account layout.
///
/// Sprint 6 T02 — ships the byte offsets `pyth-sdk-solana`'s
/// `load_price_feed_from_account_info` expects for the aggregate-price
/// read path. Any program built against `pyth-sdk-solana` that only
/// cares about `price`/`conf`/`expo`/`publish_slot` can boot unchanged
/// against a mock oracle account we write with this layout.
///
/// **Supported read path (Sprint 6 scope):**
/// - `price` → `agg.price` at offset `0xD0` (`i64`)
/// - `conf` → `agg.conf` at offset `0xD8` (`u64`)
/// - `expo` → `expo` at offset `0x14` (`i32`)
/// - `publish_slot` → `agg.pub_slot` at offset `0xE8` (`u64`)
/// - `status` → `agg.status` at offset `0xE0` (`u8`) — always written
///   as `Trading` (1) so readers do not fall through to the
///   `prev_*` path.
/// - `magic`/`ver`/`atype` validation constants at offsets `0x00`/`0x04`/`0x08`.
///
/// **Explicitly out of scope (Sprint 7+):**
/// - SMA window (`ema_price`, `ema_conf` at `0x30`/`0x48`) — zero-filled.
/// - Timestamp (`timestamp` at `0x60`, `prev_timestamp` at `0xC8`) — zero-filled.
/// - Product / next price account refs (`prod` at `0x70`, `next` at `0x90`) — zero-filled.
/// - Per-publisher component array at `0xF0` (32 × 96 bytes = 3072 bytes) — zero-filled.
///
/// **Layout reference:** `pyth-sdk-solana` `GenericPriceAccount<32, ()>`
/// is `#[repr(C)]` with 8-byte alignment; total fixed size 3312 bytes.
/// The constants below (`PYTH_MAGIC`, `PYTH_VERSION`, `PYTH_ATYPE_PRICE`,
/// `PYTH_STATUS_TRADING`) come straight from `pyth-sdk-solana/src/state.rs`.
/// A Borsh-style derive is not usable here — the Pyth struct uses
/// `bytemuck::Pod` with C repr, so we hand-assemble the bytes with
/// explicit little-endian writes at absolute offsets.
pub struct PythMockOracleLayout;

pub const PYTH_ACCOUNT_SIZE: usize = 3312;
pub const PYTH_MAGIC: u32 = 0xa1b2c3d4;
pub const PYTH_VERSION: u32 = 2;
pub const PYTH_ATYPE_PRICE: u32 = 3;
pub const PYTH_STATUS_TRADING: u8 = 1;

// Load-bearing byte offsets. Each constant is the absolute byte index
// into the `SolanaPriceAccount` Pod struct where the named field
// starts, computed from the `#[repr(C)]` declaration in
// `pyth-sdk-solana/src/state.rs`. The aggregate-price read path
// touches the subset annotated below; the rest are documented for
// clarity but stay zero-filled in Sprint 6.
pub const PYTH_OFFSET_MAGIC: usize = 0x00;
pub const PYTH_OFFSET_VER: usize = 0x04;
pub const PYTH_OFFSET_ATYPE: usize = 0x08;
pub const PYTH_OFFSET_SIZE: usize = 0x0C;
pub const PYTH_OFFSET_PTYPE: usize = 0x10; // u8 + 3 pad
pub const PYTH_OFFSET_EXPO: usize = 0x14; // i32
pub const PYTH_OFFSET_NUM: usize = 0x18;
pub const PYTH_OFFSET_NUM_QT: usize = 0x1C;
pub const PYTH_OFFSET_LAST_SLOT: usize = 0x20;
pub const PYTH_OFFSET_VALID_SLOT: usize = 0x28;
pub const PYTH_OFFSET_EMA_PRICE_VAL: usize = 0x30; // i64
pub const PYTH_OFFSET_EMA_CONF_VAL: usize = 0x48;  // i64
pub const PYTH_OFFSET_TIMESTAMP: usize = 0x60;     // i64
pub const PYTH_OFFSET_AGG_PRICE: usize = 0xD0;     // i64
pub const PYTH_OFFSET_AGG_CONF: usize = 0xD8;      // u64
pub const PYTH_OFFSET_AGG_STATUS: usize = 0xE0;    // u8
pub const PYTH_OFFSET_AGG_PUB_SLOT: usize = 0xE8;  // u64

impl OracleLayout for PythMockOracleLayout {
    fn byte_len(&self) -> usize {
        PYTH_ACCOUNT_SIZE
    }

    fn encode(&self, _admin: [u8; 32], update: &OracleUpdate) -> Result<Vec<u8>> {
        // Hand-assemble a byte buffer that matches
        // `pyth-sdk-solana::SolanaPriceAccount` at the byte-level. We
        // do NOT derive or use `bytemuck` directly — pulling the full
        // Pod struct into the engine crate would require vendoring a
        // solana-program version match against pyth-sdk-solana, which
        // is a Sprint 7+ dep-surface change. Explicit offset writes
        // are equally byte-correct and leave the dep tree untouched.
        let mut buf = vec![0u8; PYTH_ACCOUNT_SIZE];
        let price_raw = update.as_u64() as i64;
        let pub_slot: u64 = 0; // Sprint 6 ships with implicit slot=0;
                               // callers that care about slot ordering
                               // can wrap this layout with their own
                               // slot-tracking in Sprint 7+.

        write_u32_le(&mut buf, PYTH_OFFSET_MAGIC, PYTH_MAGIC);
        write_u32_le(&mut buf, PYTH_OFFSET_VER, PYTH_VERSION);
        write_u32_le(&mut buf, PYTH_OFFSET_ATYPE, PYTH_ATYPE_PRICE);
        write_u32_le(&mut buf, PYTH_OFFSET_SIZE, PYTH_ACCOUNT_SIZE as u32);
        write_i32_le(&mut buf, PYTH_OFFSET_EXPO, i32::from(update.exponent));
        // Populate EMA as a stable stand-in for the aggregate so
        // programs that read `ema_price.val` (a common safety fallback
        // alongside agg.price) see a sensible value rather than zero.
        write_i64_le(&mut buf, PYTH_OFFSET_EMA_PRICE_VAL, price_raw);
        write_i64_le(&mut buf, PYTH_OFFSET_EMA_CONF_VAL, 0);
        write_i64_le(&mut buf, PYTH_OFFSET_TIMESTAMP, 0);
        write_i64_le(&mut buf, PYTH_OFFSET_AGG_PRICE, price_raw);
        write_u64_le(&mut buf, PYTH_OFFSET_AGG_CONF, 0);
        buf[PYTH_OFFSET_AGG_STATUS] = PYTH_STATUS_TRADING;
        write_u64_le(&mut buf, PYTH_OFFSET_AGG_PUB_SLOT, pub_slot);
        Ok(buf)
    }

    fn decode(&self, bytes: &[u8]) -> Result<OracleUpdate> {
        if bytes.len() < PYTH_ACCOUNT_SIZE {
            return Err(anyhow!(
                "pyth layout decode: expected at least {PYTH_ACCOUNT_SIZE} bytes, got {}",
                bytes.len()
            ));
        }
        // Integrity checks — a program reader (`pyth-sdk-solana`) also
        // runs these, so it's useful to fail loudly locally if a
        // caller hands us foreign bytes.
        let magic = read_u32_le(bytes, PYTH_OFFSET_MAGIC);
        if magic != PYTH_MAGIC {
            return Err(anyhow!(
                "pyth layout decode: magic mismatch (got 0x{magic:08x}, expected 0x{PYTH_MAGIC:08x})"
            ));
        }
        let ver = read_u32_le(bytes, PYTH_OFFSET_VER);
        if ver != PYTH_VERSION {
            return Err(anyhow!(
                "pyth layout decode: version mismatch (got {ver}, expected {PYTH_VERSION})"
            ));
        }
        let atype = read_u32_le(bytes, PYTH_OFFSET_ATYPE);
        if atype != PYTH_ATYPE_PRICE {
            return Err(anyhow!(
                "pyth layout decode: account type is {atype}, expected Price ({PYTH_ATYPE_PRICE})"
            ));
        }
        let expo = read_i32_le(bytes, PYTH_OFFSET_EXPO);
        let agg_price = read_i64_le(bytes, PYTH_OFFSET_AGG_PRICE);
        // Sprint 6 bails on invalid expo widths — Pyth expo is i32 but
        // our `OracleUpdate.exponent` is i8 (admin-mock historical).
        // Narrow and bail on overflow so a caller that accidentally
        // writes a weird expo fails loudly rather than silently wraps.
        let narrow_expo: i8 = i8::try_from(expo).map_err(|_| {
            anyhow!("pyth layout decode: expo {expo} out of i8 range (admin-mock mirror)")
        })?;
        let price = if narrow_expo < 0 {
            let scale = 10f64.powi(i32::from(-narrow_expo));
            agg_price as f64 / scale
        } else if narrow_expo > 0 {
            let scale = 10f64.powi(i32::from(narrow_expo));
            agg_price as f64 * scale
        } else {
            agg_price as f64
        };
        Ok(OracleUpdate {
            price,
            exponent: narrow_expo,
        })
    }
}

fn write_u32_le(buf: &mut [u8], offset: usize, value: u32) {
    buf[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn write_i32_le(buf: &mut [u8], offset: usize, value: i32) {
    buf[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn write_u64_le(buf: &mut [u8], offset: usize, value: u64) {
    buf[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

fn write_i64_le(buf: &mut [u8], offset: usize, value: i64) {
    buf[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

fn read_u32_le(buf: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(buf[offset..offset + 4].try_into().unwrap())
}

fn read_i32_le(buf: &[u8], offset: usize) -> i32 {
    i32::from_le_bytes(buf[offset..offset + 4].try_into().unwrap())
}

fn read_i64_le(buf: &[u8], offset: usize) -> i64 {
    i64::from_le_bytes(buf[offset..offset + 8].try_into().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;
    use borsh::to_vec;

    /// SSOT enforcement for `OracleSnapshot` (PAU-01).
    ///
    /// These golden bytes are shared with `lending_pool::state::OracleState`'s
    /// matching test. If a field is added, removed, reordered, or resized on
    /// this side, this test fails. The on-chain side has a mirror test against
    /// the same file.
    #[test]
    fn oracle_snapshot_matches_golden_bytes() {
        const GOLDEN: &[u8] =
            include_bytes!("../../../fixtures/oracle_state_golden.bin");

        let snapshot = OracleSnapshot {
            is_initialized: true,
            admin: [7; 32],
            price: 123,
            exponent: -2,
            reserved: [0; 8],
        };

        let encoded = to_vec(&snapshot).expect("encode oracle snapshot");
        assert_eq!(
            encoded.len(),
            GOLDEN.len(),
            "OracleSnapshot serialized length drifted from the golden file ({} bytes). \
             If this change is intentional, regenerate fixtures/oracle_state_golden.bin \
             AND update the mirror test in programs/lending_pool/src/state.rs.",
            GOLDEN.len(),
        );
        assert_eq!(
            encoded.as_slice(),
            GOLDEN,
            "OracleSnapshot layout drifted from fixtures/oracle_state_golden.bin. \
             Update both sides (engine::scenario::oracle and \
             lending_pool::state::OracleState) in lock-step."
        );

        let decoded = decode_oracle(GOLDEN).expect("decode golden bytes");
        assert_eq!(decoded, snapshot);
    }

    #[test]
    fn oracle_snapshot_roundtrips_through_borsh() {
        let snapshot = OracleSnapshot {
            is_initialized: true,
            admin: [7; 32],
            price: 123,
            exponent: -2,
            reserved: [0; 8],
        };

        let encoded = to_vec(&snapshot).unwrap();
        let decoded = decode_oracle(&encoded).unwrap();

        assert_eq!(decoded, snapshot);
    }

    #[test]
    fn oracle_update_scales_fractional_prices_with_exponent() {
        let update = OracleUpdate {
            price: 1.23,
            exponent: -2,
        };

        assert_eq!(update.as_u64(), 123);
    }
}
