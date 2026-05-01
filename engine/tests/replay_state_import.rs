use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use riptide_engine::{
    adapter::{ReplayBlock, ReplayStateSource},
    agent::policy::LENDING_RUNTIME_ACTIONS,
    harness::{lending::LendingPoolConfig, setup::default_program_so_path},
    replay::load_state_pack,
    replay::{import_replay_state, StateImportError},
    sim::{
        litesvm::{LiteSvmBootstrapConfig, LiteSvmHarness},
        run_simulation, SimulationParams,
    },
    types::{Policy, PositionSizing, PositionSizingStrategy, RunConfig},
};
use serde_json::Value;
use sha2::{Digest, Sha256};

const ORACLE_PUBKEY: &str = "So11111111111111111111111111111111111111112";
const RESERVE_PUBKEY: &str = "FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH";
const RESERVE_2_PUBKEY: &str = "GLe1xiYPUBRQCrxQA1wMVSESmCqY1YgVi1Rrhu7oMUhk";
const ORACLE_SHA256: &str = "223ea9a77f8c1b7f8b0d4f454efcd8d729bfdfa891783687c5f2d93499f72351";
const RESERVE_SHA256: &str = "e32cba8adbecf677501b822197be59ced6737ab44999d482fe0fbf829e0f559c";

const TWO_RESERVE_SIM_ADAPTER: &str = r#"
protocol = "lending"

[instructions]
deposit   = { action = "deposit",   amount = "amount" }
borrow    = { action = "borrow",    amount = "amount" }
repay     = { action = "repay",     amount = "amount" }
withdraw  = { action = "withdraw",  amount = "amount" }
liquidate = { action = "liquidate", amount = "repay_amount" }

[state_mapping]
"pool.total_deposits" = "tvl"
"pool.total_borrows"  = "debt"
"pool.bad_debt"       = "bad_debt"
"position.collateral" = "collateral"
"position.debt"       = "debt"
"position.liquidated" = "liquidated"

[semantics]
class = "lending.v1"

[semantics.roles.position]
source = "account.position"
fields.collateral_amount = "u128"
fields.debt_amount = "u128"

[semantics.roles.reserve]
source = "account.reserve"
fields.liquidity = "u128"

[semantics.roles.oracle]
source = "account.oracle"
fields.price = "u128"
fields.confidence = "u64"

[semantics.roles.liquidation_config]
source = "account.reserve"
fields.liquidation_threshold_bps = "u64"

[semantics.collections.total_liquidity]
over = "reserves"
formula = "sum"
expr = "reserve.liquidity"
"#;

fn fixture_base() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn replay_block(pack_path: &str) -> ReplayBlock {
    ReplayBlock {
        state_source: Some("fixture".into()),
        pack_path: Some(pack_path.into()),
        slot: Some(123456789),
        roles: BTreeMap::from([
            ("oracle".into(), ORACLE_PUBKEY.into()),
            ("reserve".into(), RESERVE_PUBKEY.into()),
        ]),
        state_source_ref: None,
    }
}

fn copy_dir(src: &Path, dest: &Path) {
    fs::create_dir_all(dest).expect("create destination dir");
    for entry in fs::read_dir(src).expect("read source dir") {
        let entry = entry.expect("read source entry");
        let src_path = entry.path();
        let dest_path = dest.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir(&src_path, &dest_path);
        } else {
            fs::copy(&src_path, &dest_path).expect("copy fixture file");
        }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("{digest:x}")
}

fn write_current_state_pack(
    root: &Path,
    account_pubkey: &str,
    manifest_overrides: Option<Value>,
) -> PathBuf {
    let pack = root.join("current-pack");
    fs::create_dir_all(pack.join("accounts")).unwrap();
    let account_json = serde_json::to_string_pretty(&serde_json::json!({
        "pubkey": account_pubkey,
        "owner": "11111111111111111111111111111111",
        "lamports": 123,
        "executable": false,
        "rent_epoch": 0,
        "data_b64": "UklQVElERQ=="
    }))
    .unwrap()
        + "\n";
    fs::write(
        pack.join("accounts").join(format!("{account_pubkey}.json")),
        &account_json,
    )
    .unwrap();
    let mut manifest = serde_json::json!({
        "version": 1,
        "kind": "state-pack",
        "mode": "current-from-explicit-accounts",
        "slot": 42,
        "source": { "accounts": [account_pubkey], "slot": 42 },
        "warnings": [],
        "accounts": {}
    });
    manifest["accounts"][account_pubkey] = serde_json::json!({
        "account_pubkey": account_pubkey,
        "path": format!("accounts/{account_pubkey}.json"),
        "sha256_hash": sha256_hex(account_json.as_bytes())
    });
    if let Some(overrides) = manifest_overrides {
        merge_json(&mut manifest, overrides);
    }
    fs::write(
        pack.join("manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap() + "\n",
    )
    .unwrap();
    pack
}

fn merge_json(target: &mut Value, patch: Value) {
    match (target, patch) {
        (Value::Object(target), Value::Object(patch)) => {
            for (key, value) in patch {
                merge_json(target.entry(key).or_insert(Value::Null), value);
            }
        }
        (target, patch) => *target = patch,
    }
}

#[test]
fn replay_state_import_fixture_loader_reads_manifest_accounts_and_provenance() {
    let import = import_replay_state(&replay_block("state-pack-demo"), &fixture_base())
        .expect("load fixture state pack");

    assert_eq!(import.accounts.len(), 2);
    let oracle = import.accounts.get("oracle").expect("oracle account");
    assert_eq!(oracle.len(), 1);
    let oracle = &oracle[0];
    assert_eq!(oracle.pubkey.to_string(), ORACLE_PUBKEY);
    assert_eq!(oracle.account.lamports, 2039280);
    assert_eq!(oracle.account.data, b"RIPTIDE\x02");
    assert_eq!(oracle.sha256_hash, ORACLE_SHA256);

    let reserves = import.accounts.get("reserve").expect("reserve accounts");
    assert_eq!(reserves.len(), 2);
    assert_eq!(reserves[0].pubkey.to_string(), RESERVE_PUBKEY);
    assert_eq!(reserves[0].account.lamports, 4078560);
    assert_eq!(reserves[0].sha256_hash, RESERVE_SHA256);
    assert_eq!(reserves[1].pubkey.to_string(), RESERVE_2_PUBKEY);
    assert_eq!(reserves[1].account.lamports, 4078560);
    assert_eq!(reserves[1].sha256_hash, RESERVE_SHA256);

    assert_eq!(import.provenance.pack_path, "state-pack-demo");
    assert_eq!(import.provenance.slot, 123456789);
    assert_eq!(
        import.provenance.accounts["oracle"].account_pubkey,
        ORACLE_PUBKEY
    );
    assert_eq!(
        import.provenance.accounts["oracle"].sha256_hash,
        ORACLE_SHA256
    );
    assert_eq!(
        import.provenance.accounts["reserve"].account_pubkey,
        RESERVE_PUBKEY
    );
    assert_eq!(
        import.provenance.accounts["reserve"].account_pubkeys,
        vec![RESERVE_PUBKEY.to_string(), RESERVE_2_PUBKEY.to_string()]
    );
    assert_eq!(
        import.provenance.accounts["reserve"].sha256_hash,
        RESERVE_SHA256
    );
}

#[test]
fn current_state_pack_loader_reads_hash_checked_accounts_and_provenance() {
    let temp = tempfile::tempdir().expect("tempdir");
    let pack = write_current_state_pack(temp.path(), ORACLE_PUBKEY, None);

    let import = load_state_pack(&pack).expect("load current-state pack");

    assert_eq!(import.accounts.len(), 1);
    assert_eq!(import.accounts[0].pubkey.to_string(), ORACLE_PUBKEY);
    assert_eq!(import.accounts[0].account.data, b"RIPTIDE");
    assert_eq!(import.provenance.slot, 42);
    assert_eq!(
        import.provenance.accounts[ORACLE_PUBKEY].account_pubkey,
        ORACLE_PUBKEY
    );
}

#[test]
fn current_state_pack_loader_rejects_unsafe_account_paths() {
    let temp = tempfile::tempdir().expect("tempdir");
    let mut overrides = serde_json::json!({ "accounts": {} });
    overrides["accounts"][ORACLE_PUBKEY] = serde_json::json!({
        "path": "../escape.json"
    });
    let pack = write_current_state_pack(temp.path(), ORACLE_PUBKEY, Some(overrides));

    let err = load_state_pack(&pack).expect_err("must fail");
    assert!(matches!(
        err,
        StateImportError::UnsafeStatePackAccountPath { account_pubkey, .. }
            if account_pubkey == ORACLE_PUBKEY
    ));
}

#[test]
fn current_state_pack_loader_rejects_slot_source_inconsistency() {
    let temp = tempfile::tempdir().expect("tempdir");
    let pack = write_current_state_pack(
        temp.path(),
        ORACLE_PUBKEY,
        Some(serde_json::json!({
            "source": { "slot": 41 }
        })),
    );

    let err = load_state_pack(&pack).expect_err("must fail");
    assert!(matches!(
        err,
        StateImportError::SlotSourceInconsistency {
            slot: 42,
            source_slot: 41
        }
    ));
}

#[test]
fn current_state_pack_loader_rejects_malformed_pubkeys() {
    let temp = tempfile::tempdir().expect("tempdir");
    let mut overrides = serde_json::json!({ "accounts": {} });
    overrides["accounts"][ORACLE_PUBKEY] = serde_json::json!({
        "account_pubkey": "not-a-pubkey"
    });
    let pack = write_current_state_pack(temp.path(), ORACLE_PUBKEY, Some(overrides));

    let err = load_state_pack(&pack).expect_err("must fail");
    assert!(matches!(
        err,
        StateImportError::InvalidPubkey { value, .. } if value == "not-a-pubkey"
    ));
}

#[test]
fn replay_state_import_two_reserve_pack_drives_one_tick_simulation() {
    let adapter = riptide_engine::adapter::parse_adapter_str(
        TWO_RESERVE_SIM_ADAPTER,
        "state-import-two-reserve-sim.toml",
    )
    .unwrap();
    let import = import_replay_state(&replay_block("state-pack-demo"), &fixture_base())
        .expect("load fixture state pack");
    let program_so = default_program_so_path();
    let mut harness = LiteSvmHarness::bootstrap(LiteSvmBootstrapConfig {
        program_so,
        agent_count: 1,
        starting_price: 100,
        price_exponent: 0,
        pool_config: LendingPoolConfig {
            ltv_bps: 7_000,
            liquidation_threshold_bps: 8_000,
            liquidation_bonus_bps: 500,
            interest_bps: 250,
            deposit_limit: u64::MAX / 4,
            borrow_limit: u64::MAX / 4,
        },
        seed_deposit: 0,
        adapter: Some(adapter.clone()),
    })
    .expect("bootstrap LiteSVM lending harness");
    for (role, accounts) in &import.accounts {
        for account in accounts {
            harness
                .import_account_for_role(Some(role), account.pubkey, account.account.clone())
                .expect("import account into LiteSVM");
        }
    }

    let cfg = RunConfig {
        agents: 1,
        ticks: 0,
        scenario: "baseline".into(),
        seed: 7,
        personas: vec!["state-import-reader".into()],
        validator_url: "unused".into(),
        output_path: "unused".into(),
    };
    let policy = Policy {
        persona_id: "state-import-reader".into(),
        persona_label: "state-import-reader".into(),
        action_rate_multiplier: 1.0,
        risk_tolerance: 0.5,
        action_weights: BTreeMap::new(),
        triggers: Vec::new(),
        position_sizing: PositionSizing {
            strategy: PositionSizingStrategy::Fixed,
            params: BTreeMap::new(),
        },
        max_exposure: 1.0,
        persona_args: BTreeMap::new(),
    };
    let mut scenario = riptide_engine::scenario::BaselineScenario::new(100.0, 0);
    let params = SimulationParams {
        run_config: &cfg,
        policies: vec![policy],
        agent_personas: vec![0],
        available_actions: LENDING_RUNTIME_ACTIONS.to_vec(),
        starting_balance: 10_000.0,
        starting_price: 100.0,
        simulation_boundaries: vec!["state import two-reserve runtime proof".into()],
        invariants: adapter.invariants.clone(),
        scheduled_actions: Vec::new(),
        semantics: adapter.semantics.clone(),
        errors: Vec::new(),
    };

    let result = run_simulation(&mut harness, &mut scenario, params).unwrap();
    let collection = result.timeseries[0]["collection_observations"]
        .as_object()
        .expect("collection observations object");
    assert_eq!(collection["total_liquidity"].as_u64(), Some(230));
    assert_eq!(
        import.provenance.accounts["reserve"].sha256_hash,
        RESERVE_SHA256
    );
}

#[test]
fn replay_state_import_fixture_loader_rejects_missing_sha256_hash_fail_closed() {
    let temp = tempfile::tempdir().expect("tempdir");
    let pack = temp.path().join("state-pack-demo");
    copy_dir(&fixture_base().join("state-pack-demo"), &pack);

    let manifest_path = pack.join("manifest.json");
    let mut manifest: Value =
        serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
    manifest["accounts"]["reserve"]
        .as_object_mut()
        .expect("reserve manifest account")
        .remove("sha256_hash");
    fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&manifest).unwrap() + "\n",
    )
    .unwrap();

    let err =
        import_replay_state(&replay_block("state-pack-demo"), temp.path()).expect_err("must fail");
    assert!(matches!(
        err,
        StateImportError::MissingSha256Hash { role } if role == "reserve"
    ));
}

#[test]
fn replay_state_import_fixture_loader_rejects_sha256_mismatch_fail_closed() {
    let temp = tempfile::tempdir().expect("tempdir");
    let pack = temp.path().join("state-pack-demo");
    copy_dir(&fixture_base().join("state-pack-demo"), &pack);

    fs::write(
        pack.join("accounts/reserve.json"),
        serde_json::to_string_pretty(&serde_json::json!([{
            "pubkey": RESERVE_PUBKEY,
            "owner": "11111111111111111111111111111111",
            "lamports": 4078560,
            "executable": false,
            "rent_epoch": 0,
            "data_b64": "AAECAw=="
        }]))
        .unwrap()
            + "\n",
    )
    .unwrap();

    let err =
        import_replay_state(&replay_block("state-pack-demo"), temp.path()).expect_err("must fail");
    match err {
        StateImportError::Sha256Mismatch {
            role,
            expected,
            actual,
            ..
        } => {
            assert_eq!(role, "reserve");
            assert_eq!(expected, RESERVE_SHA256);
            assert_ne!(actual, expected);
        }
        other => panic!("expected Sha256Mismatch, got {other:?}"),
    }
}

#[test]
fn replay_state_import_mainnet_rpc_is_typed_runtime_error_with_pack_state_hint() {
    let replay = ReplayBlock {
        state_source: Some("mainnet-rpc".into()),
        pack_path: None,
        slot: Some(123456789),
        roles: BTreeMap::new(),
        state_source_ref: Some(ReplayStateSource::MainnetRpc),
    };

    let err = import_replay_state(&replay, Path::new(".")).expect_err("must fail");
    assert!(matches!(
        err,
        StateImportError::MainnetRpcNotImplemented { .. }
    ));
    let msg = err.to_string();
    assert!(msg.contains("MainnetRpcNotImplemented"));
    assert!(msg.contains("riptide pack-state"));
}
