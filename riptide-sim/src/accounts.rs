// Adapted from Trident (MIT) — https://github.com/Ackee-Blockchain/trident

use std::collections::BTreeMap;

use solana_sdk::{
    pubkey::Pubkey,
    signature::{Keypair, Signer},
};

use crate::World;

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

    pub fn insert_keypair_and_register(
        &mut self,
        name: impl Into<String>,
        keypair: Keypair,
        world: &mut World,
    ) -> Pubkey {
        let pubkey = world.register_keypair_ref(&keypair);
        self.insert_keypair(name, keypair);
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

    pub fn get_or_create_keypair(&mut self, name: impl Into<String>) -> Pubkey {
        let name = name.into();
        if let Some(pubkey) = self.addresses.get(&name) {
            return *pubkey;
        }
        self.insert_keypair(name, Keypair::new())
    }

    pub fn get_or_create_keypair_and_register(
        &mut self,
        name: impl Into<String>,
        world: &mut World,
    ) -> Pubkey {
        let name = name.into();
        if let Some(keypair) = self.keypairs.get(&name) {
            return world.register_keypair_ref(keypair);
        }
        let keypair = Keypair::new();
        self.insert_keypair_and_register(name, keypair, world)
    }

    pub fn family_name(family: &str, index: usize) -> String {
        format!("{family}:{index}")
    }

    pub fn insert_family(&mut self, family: &str, index: usize, pubkey: Pubkey) -> Pubkey {
        self.insert(Self::family_name(family, index), pubkey)
    }

    pub fn insert_family_keypair(
        &mut self,
        family: &str,
        index: usize,
        keypair: Keypair,
    ) -> Pubkey {
        self.insert_keypair(Self::family_name(family, index), keypair)
    }

    pub fn get_family(&self, family: &str, index: usize) -> Pubkey {
        self.get(&Self::family_name(family, index))
    }

    pub fn get_or_create_family_keypair(&mut self, family: &str, index: usize) -> Pubkey {
        self.get_or_create_keypair(Self::family_name(family, index))
    }

    pub fn insert_agent(&mut self, index: usize, pubkey: Pubkey) -> Pubkey {
        self.insert_family("agent", index, pubkey)
    }

    pub fn agent(&self, index: usize) -> Pubkey {
        self.get_family("agent", index)
    }

    pub fn insert_target(&mut self, index: usize, pubkey: Pubkey) -> Pubkey {
        self.insert_family("target", index, pubkey)
    }

    pub fn target(&self, index: usize) -> Pubkey {
        self.get_family("target", index)
    }

    pub fn insert_shared(&mut self, name: impl AsRef<str>, pubkey: Pubkey) -> Pubkey {
        self.insert(format!("shared:{}", name.as_ref()), pubkey)
    }

    pub fn shared(&self, name: impl AsRef<str>) -> Pubkey {
        self.get(&format!("shared:{}", name.as_ref()))
    }

    pub fn distinct_pair(&self, first_name: &str, second_name: &str) -> (Pubkey, Pubkey) {
        let first = self.get(first_name);
        let second = self.get_except(second_name, &[first]);
        (first, second)
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

    #[test]
    fn family_and_role_helpers_are_deterministic() {
        let mut storage = AddressStorage::new();
        let agent = Pubkey::new_unique();
        let target = Pubkey::new_unique();
        let shared = Pubkey::new_unique();

        storage.insert_agent(0, agent);
        storage.insert_target(0, target);
        storage.insert_shared("pool", shared);

        assert_eq!(storage.agent(0), agent);
        assert_eq!(storage.target(0), target);
        assert_eq!(storage.shared("pool"), shared);
        assert_eq!(AddressStorage::family_name("agent", 0), "agent:0");
        assert_eq!(
            storage.get_or_create_family_keypair("agent", 1),
            storage.get_family("agent", 1)
        );
    }

    #[test]
    fn signer_registration_keeps_world_in_sync() {
        let mut storage = AddressStorage::new();
        let mut world = World::default();
        let pubkey = storage.get_or_create_keypair_and_register("agent", &mut world);

        assert_eq!(storage.get("agent"), pubkey);
        assert!(world.keypair(&pubkey).is_some());
        assert!(storage.try_keypair_for_pubkey(&pubkey).is_some());
    }
}
