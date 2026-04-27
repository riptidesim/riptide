use std::{fs, path::PathBuf};

use riptide_engine::{
    adapter::load_adapter,
    replay::{load_replay_bundle, run_lending_replay},
    sim::MockHarness,
};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("engine crate has repo parent")
        .to_path_buf()
}

#[test]
fn semantics_result_schema_pins_lending_top_level_semantics_and_expression_cap() {
    let repo = repo_root();
    let adapter = load_adapter(&repo.join("fixtures/adapters/lending.toml"))
        .expect("load migrated lending adapter");
    let tmp = tempfile::TempDir::new().expect("temp replay dir");
    fs::write(
        tmp.path().join("initial-state.json"),
        r#"{
  "instructions": [
    { "name": "deposit", "agent": "bob", "args": { "amount": 1000 } },
    { "name": "deposit", "agent": "alice", "args": { "amount": 10 } },
    { "name": "borrow", "agent": "alice", "args": { "amount": 500 } }
  ]
}
"#,
    )
    .expect("write initial-state");
    fs::write(
        tmp.path().join("trajectory.json"),
        r#"{
  "metadata": { "name": "semantics-result-schema" },
  "ticks": [
    { "tick": 4, "instructions": [] }
  ]
}
"#,
    )
    .expect("write trajectory");
    fs::write(
        tmp.path().join("oracle-trajectory.json"),
        r#"{
  "ticks": [
    { "tick": 1, "price": 50.0 }
  ]
}
"#,
    )
    .expect("write oracle trajectory");

    let bundle = load_replay_bundle(tmp.path(), &adapter).expect("load replay bundle");
    let mut harness =
        MockHarness::new(bundle.actor_ids.len(), 100.0).with_risk_params(7_000, 8_000);
    let result =
        run_lending_replay(&mut harness, &adapter, &bundle, "unused".into()).expect("run replay");
    let json = serde_json::to_value(&result).expect("serialize result");

    let semantics = json
        .get("semantics")
        .and_then(|value| value.as_object())
        .expect("top-level semantics block");
    assert_eq!(semantics["class"], "lending.v1");

    let roles = semantics["roles_bound"]
        .as_array()
        .expect("roles_bound array");
    assert_eq!(roles.len(), 4);
    assert!(roles.iter().any(|role| {
        role["role_name"] == "position" && role["source"] == "instruction.deposit_or_borrow"
    }));
    assert!(roles
        .iter()
        .any(|role| role["role_name"] == "reserve" && role["source"] == "account.reserve"));
    assert!(roles
        .iter()
        .any(|role| role["role_name"] == "oracle" && role["source"] == "account.oracle"));
    assert!(roles.iter().any(|role| {
        role["role_name"] == "liquidation_config" && role["source"] == "account.reserve"
    }));

    let derived = semantics["derived_observation_definitions"]
        .as_array()
        .expect("derived definitions array");
    assert_eq!(derived.len(), 5);
    assert!(derived.iter().any(|entry| {
        entry["name"] == "collateral_value"
            && entry["expr"] == "position.collateral_amount * reserve.collateral_price"
    }));
    assert!(derived.iter().any(|entry| {
        entry["name"] == "health_factor"
            && entry["expr"] == "liquidation_threshold_value / max(debt_value, 1)"
    }));

    let first_tick = json["timeseries"][0]["derived_observations"]
        .as_object()
        .expect("derived observations on tick 0");
    assert_eq!(first_tick["collateral_value"].as_u64(), Some(1_000));
    assert_eq!(first_tick["debt_value"].as_u64(), Some(500));

    let rows = json["summary"]["expression_invariants"]
        .as_array()
        .expect("expression_invariants array");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["name"], "bad_debt_bound");
    assert_eq!(rows[0]["expr"], "debt_value <= collateral_value");
    assert_eq!(rows[0]["severity"], "warn");
    assert_eq!(rows[0]["firing_count"].as_u64(), Some(0));
    assert_eq!(rows[0]["firings"].as_u64(), Some(0));
    assert_eq!(rows[0]["first_tick"], serde_json::Value::Null);
    assert_eq!(rows[0]["first_fired_tick"], serde_json::Value::Null);
    assert_eq!(rows[0]["observed"].as_array().unwrap().len(), 0);

    assert_eq!(rows[1]["name"], "ltv_below_max");
    assert_eq!(rows[1]["expr"], "debt_value <= max_borrow_value");
    assert_eq!(rows[1]["severity"], "warn");
    assert_eq!(rows[1]["firing_count"].as_u64(), Some(4));
    assert_eq!(rows[1]["firings"].as_u64(), Some(4));
    assert_eq!(rows[1]["first_tick"].as_u64(), Some(1));
    assert_eq!(rows[1]["first_fired_tick"].as_u64(), Some(1));
    let observed = rows[1]["observed"].as_array().expect("observed snapshots");
    assert_eq!(observed.len(), 3, "observed snapshots are capped at 3");
    assert_eq!(observed[0]["tick"].as_u64(), Some(1));
    assert_eq!(observed[1]["tick"].as_u64(), Some(2));
    assert_eq!(observed[2]["tick"].as_u64(), Some(3));
    assert_eq!(observed[0]["values"]["debt_value"].as_u64(), Some(500));
    assert_eq!(
        observed[0]["values"]["max_borrow_value"].as_u64(),
        Some(350)
    );
}
