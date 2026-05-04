// Adapted from Trident (MIT) — https://github.com/Ackee-Blockchain/trident

use std::collections::BTreeMap;

use solana_sdk::{
    pubkey::Pubkey,
    signature::{Keypair, Signer},
};

/// Named public keys and keypairs used by guided simulation flows.
#[derive(Debug, Default)]
pub struct AddressStorage {
    addresses: BTreeMap<String, Pubkey>,
    keypairs: BTreeMap<String, Keypair>,
}

impl AddressStorage {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, name: impl Into<String>, pubkey: Pubkey) -> Pubkey {
        let name = name.into();
        self.addresses.insert(name, pubkey);
        pubkey
    }

    pub fn insert_keypair(&mut self, name: impl Into<String>, keypair: Keypair) -> Pubkey {
        let name = name.into();
        let pubkey = keypair.pubkey();
        self.addresses.insert(name.clone(), pubkey);
        self.keypairs.insert(name, keypair);
        pubkey
    }

    pub fn insert_pda(
        &mut self,
        name: impl Into<String>,
        seeds: &[&[u8]],
        program_id: &Pubkey,
    ) -> (Pubkey, u8) {
        let (pubkey, bump) = Pubkey::find_program_address(seeds, program_id);
        self.insert(name, pubkey);
        (pubkey, bump)
    }

    pub fn random_keypair(&mut self, name: impl Into<String>) -> Pubkey {
        self.insert_keypair(name, Keypair::new())
    }

    pub fn get(&self, name: &str) -> Pubkey {
        *self
            .addresses
            .get(name)
            .unwrap_or_else(|| panic!("riptide sim address `{name}` is missing"))
    }

    pub fn get_except(&self, name: &str, excluded: &[Pubkey]) -> Pubkey {
        let preferred = self.get(name);
        if !excluded.contains(&preferred) {
            return preferred;
        }
        self.addresses
            .iter()
            .find_map(|(_, pubkey)| (!excluded.contains(pubkey)).then_some(*pubkey))
            .unwrap_or_else(|| {
                panic!(
                    "riptide sim address `{name}` is present, but no stored address is distinct from the excluded set"
                )
            })
    }

    pub fn keypair(&self, name: &str) -> &Keypair {
        self.keypairs
            .get(name)
            .unwrap_or_else(|| panic!("riptide sim keypair `{name}` is missing"))
    }

    pub fn try_keypair_for_pubkey(&self, pubkey: &Pubkey) -> Option<&Keypair> {
        self.keypairs
            .values()
            .find(|candidate| candidate.pubkey() == *pubkey)
    }

    pub fn addresses(&self) -> impl Iterator<Item = (&str, Pubkey)> {
        self.addresses
            .iter()
            .map(|(name, pubkey)| (name.as_str(), *pubkey))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_except_picks_distinct_address() {
        let mut storage = AddressStorage::new();
        let first = Pubkey::new_unique();
        let second = Pubkey::new_unique();
        storage.insert("first", first);
        storage.insert("second", second);

        assert_eq!(storage.get_except("first", &[first]), second);
    }
}
