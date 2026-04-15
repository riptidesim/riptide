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

/// Pyth-compatible mock layout placeholder. Reuses the admin-mock
/// byte layout for Sprint 5 so `kind = "pyth"` is still bootable; a
/// future sprint replaces `encode` / `decode` with the full Pyth Borsh
/// shape (exponent, confidence, publish slot, aggregate price).
///
/// **Scope note:** shipping a byte-for-byte Pyth-compatible layout is a
/// full day of work on its own (confidence intervals, EMA windows,
/// multi-publisher aggregation). Sprint 5 took the explicit
/// "admin-mock fallback" path documented in the task note — the
/// dispatch architecture supports adding Pyth as a second kind in
/// Sprint 6 without reshaping this module.
pub struct PythMockOracleLayout;

impl OracleLayout for PythMockOracleLayout {
    fn byte_len(&self) -> usize {
        AdminMockOracleLayout.byte_len()
    }
    fn encode(&self, admin: [u8; 32], update: &OracleUpdate) -> Result<Vec<u8>> {
        AdminMockOracleLayout.encode(admin, update)
    }
    fn decode(&self, bytes: &[u8]) -> Result<OracleUpdate> {
        AdminMockOracleLayout.decode(bytes)
    }
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
