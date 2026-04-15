//! T03 — Better Error Ergonomics for Loader Failures (Sprint 5 Phase 0)
//!
//! Each of the top 10 first-run failure modes lands here as one test
//! function that asserts the error message names (a) the file, (b) the
//! field, (c) what the engine expected, (d) what it got, and (e) a
//! next-step suggestion.
//!
//! Several modes already had unit-test coverage under
//! `engine/src/adapter/loader.rs::tests`; those are mirrored here so a
//! developer scanning for "how does Riptide handle X?" finds every
//! failure mode in one place without grepping the loader source.

use std::{fs, path::PathBuf};

use riptide_engine::{
    adapter::loader::{load_adapter, parse_adapter_str},
    agent::policy::LENDING_RUNTIME_ACTIONS,
    scenario::BaselineScenario,
    sim::{build_agent_personas, run_simulation, MockHarness, SimulationAbort, SimulationParams},
    types::{Policy, PositionSizing, PositionSizingStrategy, RunConfig},
};
use std::collections::BTreeMap;

fn workspace_tmp_dir(label: &str) -> PathBuf {
    let mut dir = std::env::temp_dir();
    dir.push(format!("riptide-t03-{label}-{}", std::process::id()));
    fs::create_dir_all(&dir).expect("mkdir tmp");
    dir
}

fn generic_toml_with_paths(program_so: &str, idl_path: &str) -> String {
    format!(
        r#"
protocol = "generic"
program_so = "{program_so}"
idl_path = "{idl_path}"

[accounts.player]
kind = "agent"
space = 32

[instructions]
mine = {{ action = "mine" }}

[state_mapping]
"player.gold" = "player.gold"

[actions.mine]
takes = []

[observations]
"player.gold" = "uint"

[personas.grinder]
action_rate_multiplier = 1.0
action_weights = {{ mine = 1.0 }}
triggers = []
"#
    )
}

// ---------------------------------------------------------------------------
// 1. Missing `program_so`
// ---------------------------------------------------------------------------

#[test]
fn t03_missing_program_so_points_to_cargo_build_sbf() {
    let dir = workspace_tmp_dir("missing-program-so");
    // Create an adapter TOML that references a non-existent .so, but
    // does exist itself so we hit the validate_resolved_paths branch.
    let idl_path = dir.join("idl.json");
    fs::write(&idl_path, "{}").unwrap();

    let toml_path = dir.join("adapter.toml");
    fs::write(
        &toml_path,
        generic_toml_with_paths(
            &dir.join("missing.so").display().to_string(),
            &idl_path.display().to_string(),
        ),
    )
    .unwrap();

    let err = load_adapter(&toml_path).unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("adapter.toml"), "missing path: {msg}");
    assert!(msg.contains("program_so"), "missing field: {msg}");
    assert!(msg.contains("missing.so"), "missing actual path: {msg}");
    assert!(
        msg.contains("cargo build-sbf"),
        "missing next-step suggestion: {msg}"
    );
}

// ---------------------------------------------------------------------------
// 2. Malformed TOML
// ---------------------------------------------------------------------------

#[test]
fn t03_malformed_toml_hints_at_brackets_and_quotes() {
    // Missing closing bracket on an inline table.
    let toml_str = "protocol = \"lending\"\n[instructions\n";
    let err = parse_adapter_str(toml_str, "busted.toml").unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("busted.toml"), "missing path: {msg}");
    assert!(msg.contains("parse failed"), "missing parse marker: {msg}");
    assert!(
        msg.contains("unclosed bracket") && msg.contains("missing quote"),
        "missing syntax hint: {msg}"
    );
}

// ---------------------------------------------------------------------------
// 3. Wrong account space (declared too small)
// ---------------------------------------------------------------------------

#[test]
fn t03_wrong_account_space_names_account_and_required_minimum() {
    let toml_str = r#"
protocol = "generic"
program_so = "foo.so"
idl_path = "foo.json"

[accounts.pool]
kind = "shared"
space = 4

[instructions]
tick = { action = "tick" }

[state_mapping]
"pool.total" = "pool.total"

[actions.tick]
takes = []

[observations]
"pool.total" = "uint"

[personas.a]
action_rate_multiplier = 1.0
action_weights = { tick = 1.0 }
triggers = []
"#;
    let err = parse_adapter_str(toml_str, "space.toml").unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("space.toml"), "missing path: {msg}");
    assert!(msg.contains("[accounts].pool.space"), "missing key: {msg}");
    assert!(msg.contains("declared"), "missing actual value cue: {msg}");
    assert!(msg.contains("4"), "missing actual value: {msg}");
    assert!(msg.contains("8"), "missing required minimum: {msg}");
    assert!(
        msg.contains("discriminator"),
        "missing rationale: {msg}"
    );
}

/// When the adapter points at a real IDL that declares typed fields for
/// an account, the loader must cross-check the declared `space` against
/// the fixed-field minimum byte count from the IDL and emit a
/// declared-vs-expected message (Sprint 5 T03 reviewer feedback).
#[test]
fn t03_wrong_account_space_uses_idl_fixed_field_minimum() {
    let dir = workspace_tmp_dir("idl-backed-space");
    // IDL declares `player { owner: pubkey(32), gold: u64(8), wood: u64(8) }`
    // → fixed minimum = 48 bytes. Adapter declares 24 → should reject.
    let idl = serde_json::json!({
        "instructions": [],
        "accounts": [
            {
                "name": "player",
                "fields": [
                    { "name": "owner", "type": "pubkey" },
                    { "name": "gold",  "type": "u64" },
                    { "name": "wood",  "type": "u64" }
                ]
            }
        ]
    });
    let idl_path = dir.join("idl.json");
    fs::write(&idl_path, serde_json::to_string(&idl).unwrap()).unwrap();
    // A fake empty .so is enough — the existence check doesn't read it.
    let so_path = dir.join("dummy.so");
    fs::write(&so_path, []).unwrap();
    let toml_str = format!(
        r#"
protocol = "generic"
program_so = "{so_path}"
idl_path = "{idl_path}"

[accounts.player]
kind = "agent"
space = 24

[instructions]
mine = {{ action = "mine" }}

[state_mapping]
"player.gold" = "player.gold"

[actions.mine]
takes = []

[observations]
"player.gold" = "uint"

[personas.grinder]
action_rate_multiplier = 1.0
action_weights = {{ mine = 1.0 }}
triggers = []
"#,
        so_path = so_path.display(),
        idl_path = idl_path.display(),
    );
    let toml_path = dir.join("adapter.toml");
    fs::write(&toml_path, &toml_str).unwrap();

    let err = load_adapter(&toml_path).unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("[accounts].player.space"),
        "missing key: {msg}"
    );
    assert!(msg.contains("24"), "missing declared value: {msg}");
    assert!(
        msg.contains("48"),
        "missing expected value from IDL: {msg}"
    );
    assert!(
        msg.contains("at least"),
        "missing declared-vs-expected phrasing: {msg}"
    );
}

// ---------------------------------------------------------------------------
// 4. Invalid persona reference in run-config
// ---------------------------------------------------------------------------

fn trivial_policy(id: &str) -> Policy {
    Policy {
        persona_id: id.into(),
        persona_label: id.into(),
        action_rate_multiplier: 1.0,
        risk_tolerance: 0.5,
        action_weights: BTreeMap::new(),
        triggers: Vec::new(),
        position_sizing: PositionSizing {
            strategy: PositionSizingStrategy::Fixed,
            params: BTreeMap::new(),
        },
        max_exposure: 0.5,
    }
}

#[test]
fn t03_invalid_persona_reference_lists_available_personas() {
    let policies = vec![
        trivial_policy("cautious-yield-farmer"),
        trivial_policy("steady-lp"),
    ];
    let err = build_agent_personas(
        &vec!["whale".to_string()],
        &policies,
        3,
    )
    .unwrap_err();
    let msg = match err {
        SimulationAbort::BadInput(m) => m,
        other => panic!("expected BadInput, got: {other:?}"),
    };
    assert!(msg.contains("whale"), "missing bad id: {msg}");
    assert!(
        msg.contains("cautious-yield-farmer") && msg.contains("steady-lp"),
        "missing available list: {msg}"
    );
    assert!(msg.contains("Fix"), "missing next-step: {msg}");
}

// ---------------------------------------------------------------------------
// 5. Missing run-config file (covered via the adapter loader's IO path —
//    main.rs uses a sibling helper that composes the same pattern).
// ---------------------------------------------------------------------------

#[test]
fn t03_missing_adapter_file_mentions_path_and_suggests_next_step() {
    // This is failure mode #6 in the spec but shares the IO path with
    // #5 (missing run-config). The run-config branch lives in
    // `engine/src/main.rs::friendly_read_error`; binary-level coverage
    // runs through `engine_cli_e2e.rs`. Here we drive the adapter
    // path, which is the first file a user points at and thus the
    // most common failure.
    let err = load_adapter(std::path::Path::new(
        "/nonexistent/riptide/adapter.toml",
    ))
    .unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("/nonexistent/riptide/adapter.toml"),
        "missing path: {msg}"
    );
    assert!(
        msg.contains("not found"),
        "missing not-found marker: {msg}"
    );
    assert!(
        msg.contains("--adapter") || msg.contains("adapter TOML"),
        "missing next-step cue: {msg}"
    );
}

// ---------------------------------------------------------------------------
// 7. Wrong observation field (generic trigger references unknown obs)
// ---------------------------------------------------------------------------

#[test]
fn t03_unknown_observation_in_trigger_lists_declared_set() {
    let toml_str = r#"
protocol = "generic"
program_so = "foo.so"
idl_path = "foo.json"

[accounts.player]
kind = "agent"
space = 32

[instructions]
mine = { action = "mine" }

[state_mapping]
"player.gold" = "player.gold"

[actions.mine]
takes = []

[observations]
"player.gold" = "uint"

[personas.grinder]
action_rate_multiplier = 1.0
action_weights = { mine = 1.0 }
triggers = [{ if = "player.wood < 10", then = "mine", weight_boost = 2.0 }]
"#;
    let err = parse_adapter_str(toml_str, "obs.toml").unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("obs.toml"), "missing path: {msg}");
    assert!(
        msg.contains("triggers[0].if"),
        "missing field key: {msg}"
    );
    assert!(msg.contains("player.wood"), "missing bad obs: {msg}");
    assert!(
        msg.contains("Declared observations"),
        "missing declared list: {msg}"
    );
    assert!(msg.contains("player.gold"), "missing known obs: {msg}");
}

// Also assert the lending-path invariant-field validator lists the
// known set (T01 wiring — covered here as a regression assertion).
#[test]
fn t03_lending_invariant_unknown_field_lists_known_metrics() {
    let toml_str = r#"
protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"

[[invariants]]
name = "fake"
field = "magic_metric"
op = "<="
value = 1.0
"#;
    let err = parse_adapter_str(toml_str, "inv.toml").unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("inv.toml"), "missing path: {msg}");
    assert!(msg.contains("[[invariants]][0].field"), "missing key: {msg}");
    assert!(msg.contains("magic_metric"), "missing bad field: {msg}");
    assert!(
        msg.contains("snapshot metric") || msg.contains("tvl"),
        "missing guidance toward known set: {msg}"
    );
}

// ---------------------------------------------------------------------------
// 8. Invalid instruction in `[instructions]`
// ---------------------------------------------------------------------------

#[test]
fn t03_unknown_lending_action_lists_valid_set() {
    let toml_str = r#"
protocol = "lending"

[instructions]
foo = { action = "bogus" }

[state_mapping]
"pool.total_deposits" = "tvl"
"#;
    let err = parse_adapter_str(toml_str, "ix.toml").unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("ix.toml"), "missing path: {msg}");
    assert!(
        msg.contains("[instructions].foo.action"),
        "missing key: {msg}"
    );
    assert!(msg.contains("bogus"), "missing bad action: {msg}");
    assert!(
        msg.contains("expected one of") && msg.contains("deposit"),
        "missing expected set: {msg}"
    );
}

// ---------------------------------------------------------------------------
// 9. Engine binary missing — covered in CLI tests. See
//    `cli/test/errors.test.ts` for the TypeScript assertion that
//    `resolveEngineBinary` produces a cargo-build hint.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 10. Wrong toolchain version — reasonable runtime coverage is out of
//     scope per the task spec. This test function is #[ignore]d and
//     exists as a pointer so future work knows where to land the check
//     once T04's install flow gives us a version manifest to compare
//     against. See TOOLCHAIN.md.
// ---------------------------------------------------------------------------

#[test]
#[ignore = "toolchain drift is documented in TOOLCHAIN.md; runtime check deferred to T04 install flow"]
fn t03_toolchain_version_drift_is_documented() {
    // No assertion — see TOOLCHAIN.md and install.sh.
}

// ---------------------------------------------------------------------------
// Sanity: the improvements did not break the happy path through a
// lending run that has no invariants and no adapter. This guards the
// Sprint 4 hero grid byte-stability contract.
// ---------------------------------------------------------------------------

#[test]
fn t03_happy_path_lending_run_still_succeeds_with_improved_errors() {
    let run_config = RunConfig {
        agents: 2,
        ticks: 5,
        scenario: "baseline".into(),
        seed: 42,
        personas: vec!["steady".into()],
        validator_url: "http://127.0.0.1:8899".into(),
        output_path: "/tmp/riptide-t03-out".into(),
    };
    let policies = vec![trivial_policy("steady")];
    let personas = build_agent_personas(&run_config.personas, &policies, 2).unwrap();
    let mut harness = MockHarness::new(2, 100.0);
    let mut scenario = BaselineScenario::new(100.0, 5);
    let params = SimulationParams {
        run_config: &run_config,
        policies,
        agent_personas: personas,
        available_actions: LENDING_RUNTIME_ACTIONS.to_vec(),
        starting_balance: 1_000.0,
        starting_price: 100.0,
        simulation_boundaries: vec!["t03 happy".into()],
        invariants: Vec::new(),
        scheduled_actions: Vec::new(),
    };
    let result = run_simulation(&mut harness, &mut scenario, params).unwrap();
    assert_eq!(result.seed, 42);
}
