use anyhow::{anyhow, Result};
use borsh::{to_vec, BorshDeserialize, BorshSerialize};
use solana_sdk::{instruction::Instruction, pubkey::Pubkey};

use crate::harness::lending::LendingProgramClient;

/// Engine-side mirror of the on-chain oracle account layout.
///
/// **SSOT note (T01 / PAU-01):** this struct is a byte-for-byte Borsh mirror
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

#[derive(Debug, Clone, PartialEq, BorshSerialize, BorshDeserialize)]
pub enum OracleInstructionData {
    SetPrice { price: u64, exponent: i8 },
}

pub fn set_price_instruction(
    program_id: Pubkey,
    admin: Pubkey,
    oracle: Pubkey,
    update: &OracleUpdate,
) -> Instruction {
    Instruction {
        program_id,
        accounts: vec![
            solana_sdk::instruction::AccountMeta::new_readonly(admin, true),
            solana_sdk::instruction::AccountMeta::new(oracle, false),
        ],
        data: to_vec(&OracleInstructionData::SetPrice {
            price: update.as_u64(),
            exponent: update.exponent,
        })
        .expect("oracle instruction"),
    }
}

/// Bridge an `OracleUpdate` produced by the scenario engine into a real
/// on-chain `LendingInstructionData::SetOraclePrice` instruction. Phase 3 will
/// call this from the tick loop; for now it lives here so the wiring is
/// trivial.
pub fn build_set_price_instruction(
    client: &LendingProgramClient,
    admin: Pubkey,
    oracle: Pubkey,
    update: &OracleUpdate,
) -> Instruction {
    client.set_oracle_price(admin, oracle, update.as_u64(), update.exponent)
}

pub fn decode_oracle(bytes: &[u8]) -> Result<OracleSnapshot> {
    OracleSnapshot::try_from_slice(bytes).map_err(|error| anyhow!(error))
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn build_set_price_instruction_matches_lending_client() {
        use crate::harness::lending::{LendingInstructionData, LendingProgramClient};

        let program_id = Pubkey::new_unique();
        let admin = Pubkey::new_unique();
        let oracle = Pubkey::new_unique();
        let client = LendingProgramClient::new(program_id);
        let update = OracleUpdate {
            price: 1.23,
            exponent: -2,
        };

        let ix = build_set_price_instruction(&client, admin, oracle, &update);

        assert_eq!(ix.program_id, program_id);
        assert_eq!(ix.accounts.len(), 2);
        assert_eq!(ix.accounts[0].pubkey, admin);
        assert!(ix.accounts[0].is_signer);
        assert!(!ix.accounts[0].is_writable);
        assert_eq!(ix.accounts[1].pubkey, oracle);
        assert!(!ix.accounts[1].is_signer);
        assert!(ix.accounts[1].is_writable);

        let decoded = LendingInstructionData::try_from_slice(&ix.data)
            .expect("decode SetOraclePrice payload");
        match decoded {
            LendingInstructionData::SetOraclePrice { price, exponent } => {
                assert_eq!(price, 123);
                assert_eq!(exponent, -2);
            }
            other => panic!("unexpected instruction variant: {other:?}"),
        }
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
