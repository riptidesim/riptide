pub mod oracle_trajectory;
pub mod run;
pub mod state_import;
pub mod trajectory;

#[cfg(any(feature = "litesvm-backend", test))]
pub mod multi;

pub use oracle_trajectory::{OracleTrajectory, OracleTrajectoryTick};
pub use run::{load_replay_bundle, run_lending_replay, run_replay, ReplayBundle};
pub use state_import::{
    import_replay_state, load_state_pack, ImportedReplayAccount, ImportedStatePackAccount,
    ReplayStateAccountProvenance, ReplayStateImport, ReplayStateProvenance, StateImportError,
    StatePackImport, MAINNET_RPC_NOT_IMPLEMENTED_MESSAGE,
};
pub use trajectory::{
    ReplayInitialState, ReplayInstruction, ReplayMetadata, ReplayTick, ReplayTrajectory,
};

#[cfg(any(feature = "litesvm-backend", test))]
pub use multi::{
    load_replay_config, parse_replay_config, run_multi_replay, BridgeDef, BridgeTransform,
    ComponentEntry, ComponentRuntime, ComponentSlot, LegacyReplayConfig, MultiComponentHarness,
    MultiReplayConfig, ReplayConfigShape,
};
