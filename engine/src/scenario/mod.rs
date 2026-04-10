pub mod oracle;
pub mod presets;

pub use oracle::{OracleSnapshot, OracleUpdate};
pub use presets::{BaselineScenario, PriceShockScenario};

use rand::rngs::StdRng;

pub trait Scenario {
    fn update(&mut self, tick: u32, rng: &mut StdRng) -> OracleUpdate;
}
