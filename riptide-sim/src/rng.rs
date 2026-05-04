// Adapted from Trident (MIT) — https://github.com/Ackee-Blockchain/trident

use rand::{rngs::StdRng, Rng, SeedableRng};
use solana_sdk::{pubkey::Pubkey, signature::Keypair};

/// Deterministic RNG wrapper used by generated guided simulations.
#[derive(Debug, Clone)]
pub struct RiptideRng {
    seed: [u8; 32],
    inner: StdRng,
}

impl RiptideRng {
    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self {
            seed,
            inner: StdRng::from_seed(seed),
        }
    }

    pub fn seed(&self) -> [u8; 32] {
        self.seed
    }

    pub fn seed_hex(&self) -> String {
        seed_to_hex(&self.seed)
    }

    pub fn random_from_range(&mut self, range: std::ops::Range<u64>) -> u64 {
        self.inner.random_range(range)
    }

    pub fn random_u64(&mut self) -> u64 {
        self.inner.random()
    }

    pub fn random_bool(&mut self, probability: f64) -> bool {
        self.inner.random_bool(probability)
    }

    pub fn random_pubkey(&mut self) -> Pubkey {
        let mut bytes = [0u8; 32];
        self.inner.fill(&mut bytes);
        Pubkey::new_from_array(bytes)
    }

    pub fn random_keypair(&mut self) -> Keypair {
        let mut bytes = [0u8; 32];
        self.inner.fill(&mut bytes);
        Keypair::new_from_array(bytes)
    }
}

impl Default for RiptideRng {
    fn default() -> Self {
        Self::from_seed([0x52; 32])
    }
}

pub fn seed_to_hex(seed: &[u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(64);
    for byte in seed {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

pub fn seed_from_hex(raw: &str) -> anyhow::Result<[u8; 32]> {
    let trimmed = raw.trim();
    if trimmed.len() > 64 {
        anyhow::bail!(
            "seed hex must be at most 64 characters, got {}",
            trimmed.len()
        );
    }
    if trimmed.len() % 2 != 0 {
        anyhow::bail!("seed hex must have an even number of characters");
    }
    let mut seed = [0u8; 32];
    for (idx, chunk) in trimmed.as_bytes().chunks(2).enumerate() {
        seed[idx] = (hex_nibble(chunk[0])? << 4) | hex_nibble(chunk[1])?;
    }
    Ok(seed)
}

fn hex_nibble(byte: u8) -> anyhow::Result<u8> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => anyhow::bail!("seed contains non-hex character `{}`", byte as char),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeded_rng_reproduces_values() {
        let seed = seed_from_hex("deadbeef").unwrap();
        let mut left = RiptideRng::from_seed(seed);
        let mut right = RiptideRng::from_seed(seed);

        assert_eq!(left.random_u64(), right.random_u64());
        assert_eq!(left.random_pubkey(), right.random_pubkey());
    }
}
