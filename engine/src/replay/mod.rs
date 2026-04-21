pub mod oracle_trajectory;
pub mod run;
pub mod trajectory;

#[cfg(any(feature = "litesvm-backend", test))]
pub mod multi;

pub use oracle_trajectory::{OracleTrajectory, OracleTrajectoryTick};
pub use run::{load_replay_bundle, run_replay, ReplayBundle};
pub use trajectory::{
    ReplayInitialState, ReplayInstruction, ReplayMetadata, ReplayTick, ReplayTrajectory,
};

#[cfg(any(feature = "litesvm-backend", test))]
pub use multi::{
    load_replay_config, parse_replay_config, run_multi_replay, BridgeDef, BridgeTransform,
    ComponentEntry, ComponentRuntime, ComponentSlot, LegacyReplayConfig, MultiComponentHarness,
    MultiReplayConfig, ReplayConfigShape,
};
