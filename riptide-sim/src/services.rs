// Adapted from Trident (MIT) — https://github.com/Ackee-Blockchain/trident

use crate::World;

/// Project-local services ticked between guided simulation flows.
pub trait Service {
    fn tick(&mut self, world: &mut World);
}
