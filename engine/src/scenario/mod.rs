pub mod oracle;
pub mod preset_spec;
pub mod presets;

pub use oracle::{OracleSnapshot, OracleUpdate};
pub use preset_spec::{load_presets_dir, PresetSpec, ScenarioKind};
pub use presets::{BaselineScenario, PriceShockScenario};

use rand::rngs::StdRng;

pub trait Scenario {
    fn update(&mut self, tick: u32, rng: &mut StdRng) -> OracleUpdate;
}
