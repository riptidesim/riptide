//! Pack byte-stability gate for the Sprint 11 contagion fixture.
//!
//! Two load-bearing guarantees land here:
//!
//! 1. **Determinism.** Back-to-back runs of the contagion fixture
//!    through `emit_pack` produce byte-identical file trees. Any
//!    non-determinism (timestamps, random state, env lookups) breaks
//!    the forwardability promise and this test catches it.
//! 2. **No path leaks.** The emitted pack contains zero absolute
//!    host paths, zero `$HOME` prefixes, zero `/tmp/` prefixes, and
//!    zero `/var/folders/` prefixes — regardless of where the test
//!    binary was invoked from. `emit_pack`'s internal scanner
//!    rejects these at emission, so the test asserts the happy
//!    path.
//!
//! Pinned file hashes are computed against the normalized pack
//! content. When a deliberate pack-shape change shifts the hashes,
//! regenerate with `RIPTIDE_DUMP_EXPECTED=1`.

#![cfg(feature = "litesvm-backend")]
#![cfg(not(doctest))]

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

use riptide_engine::{
    pack::{emit_pack, PackEmitOptions, PackInputs, PackOutputs},
    replay::{load_replay_config, run_multi_replay, MultiComponentHarness, ReplayConfigShape},
    types::SimulationResult,
};

fn monorepo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("engine crate has a parent directory")
        .to_path_buf()
}

fn fixture_dir() -> PathBuf {
    monorepo_root()
        .join("fixtures")
        .join("replays")
        .join("lst-lending-contagion-proof")
}

fn required_artifacts() -> Vec<(PathBuf, &'static str)> {
    let repo = monorepo_root();
    vec![
        (
            repo.join("programs/liquid-staking/target/deploy/liquid_staking.so"),
            "liquid_staking.so",
        ),
        (
            repo.join("programs/admin_mock_oracle/target/deploy/admin_mock_oracle.so"),
            "admin_mock_oracle.so",
        ),
        (
            repo.join("programs/admin_mock_oracle/target/deploy/admin_mock_oracle-keypair.json"),
            "admin_mock_oracle-keypair.json",
        ),
        (
            repo.join("programs/lending_pool/target/deploy/lending_pool.so"),
            "lending_pool.so",
        ),
    ]
}

fn skip_if_missing(path: &Path, label: &str) -> bool {
    if !path.exists() {
        if std::env::var("CI").map(|v| !v.is_empty()).unwrap_or(false) {
            panic!(
                "CI={}: refusing to soft-skip on missing {label} at {} — \
                 build it with `cargo build-sbf` before running the test suite",
                std::env::var("CI").unwrap_or_default(),
                path.display()
            );
        }
        eprintln!("skipping: {label} missing at {}", path.display());
        true
    } else {
        false
    }
}

fn canonicalize(mut result: SimulationResult) -> SimulationResult {
    result.run_config.output_path = "__canonical__".to_string();
    result
}

fn run_fixture() -> SimulationResult {
    let fixture = fixture_dir();
    let shape = load_replay_config(&fixture.join("config.json"))
        .expect("load multi-component contagion config");
    let cfg = match shape {
        ReplayConfigShape::Multi(cfg) => cfg,
        ReplayConfigShape::Legacy(_) => panic!("contagion config must be multi-component"),
    };
    let mut harness = MultiComponentHarness::bootstrap(&cfg, &fixture)
        .expect("bootstrap multi-component harness");
    canonicalize(
        run_multi_replay(&mut harness, "__canonical__".into())
            .expect("run multi-component replay"),
    )
}

fn emit_pack_for_fixture(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let repo = monorepo_root();
    let result = run_fixture();

    let mut inputs = PackInputs::default();
    inputs.config = Some(repo.join("fixtures/replays/lst-lending-contagion-proof/config.json"));
    inputs.component_adapters.push((
        "liquid_staking".into(),
        repo.join("fixtures/replays/liquid-staking-depeg-redemption-run/adapter.toml"),
    ));
    inputs.component_adapters.push((
        "lending".into(),
        repo.join("fixtures/replays/lending-whale-bad-debt/adapter.toml"),
    ));
    inputs.trajectory_dirs.push((
        "liquid_staking".into(),
        repo.join("fixtures/replays/lst-lending-contagion-proof/liquid-staking"),
    ));
    inputs.trajectory_dirs.push((
        "lending".into(),
        repo.join("fixtures/replays/lst-lending-contagion-proof/lending"),
    ));

    let outputs = PackOutputs {
        simulation_result: Some(
            repo.join("riptide-output/replays/lst-lending-contagion-proof/simulation-result.json"),
        ),
        last_run: None,
    };

    let options = PackEmitOptions {
        repo_root: repo.clone(),
        pack_dir: dir.to_path_buf(),
        command_hint: Some(
            "exec riptide-engine replay --config fixtures/replays/lst-lending-contagion-proof/config.json --output riptide-output/replays/lst-lending-contagion-proof/simulation-result.json"
                .to_string(),
        ),
        adapter_display: Some("multi-component: liquid-staking × lending_pool".to_string()),
    };

    emit_pack(&result, &inputs, &outputs, &options)
        .expect("emit pack for contagion fixture");

    collect_pack_files(dir)
}

fn collect_pack_files(root: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    walk(root, root, &mut out);
    // BTreeMap traversal order — forward-slash rel paths.
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
    let rd = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(root, &path, out);
        } else {
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let body = fs::read(&path).unwrap();
            out.push((rel, body));
        }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("{digest:x}")
}

/// Expected hashes pinned for the Sprint 11 contagion fixture pack.
///
/// To regenerate after a deliberate pack-shape change:
///   RIPTIDE_DUMP_EXPECTED=1 cargo test --features litesvm-backend \
///     --test pack_byte_stability_contagion dump_expected_pack_hashes \
///     -- --nocapture
///
/// Then paste the emitted `(name, hash)` pairs back into this
/// constant and re-run the verifying test.
const EXPECTED_PACK_HASHES: &[(&str, &str)] = &[
    ("inputs/paths.json", "a4fe09485bd0e73aabdca484299979ae60631872c43ac632de3a4ce411b0beb5"),
    ("manifest.json", "8378f16042077b655ff180c76c592d9cf4fc01bedb7de920d7e094a794f0d78b"),
    ("outputs/paths.json", "b5238b2cdb67074ece3cb9c191167a71c3750dd7ef37015c9274afc1929f63b7"),
    ("rerun.sh", "9efc7a52991233f1c3a2cde0ff12882a7ea24dcded49a82825435734cdbfcfa7"),
    ("summary.md", "19b3f5ab39ba22f1b5edc2afbadfd02610247fcaedd8d7e866908929e5039e52"),
    ("trace.md", "be1742d0a8720bfa7c2d8ed62dba2c78da4a1db39b055d474ecb11e1d9414068"),
];

#[test]
fn dump_expected_pack_hashes() {
    if std::env::var("RIPTIDE_DUMP_EXPECTED").ok().as_deref() != Some("1") {
        return;
    }
    for (path, label) in required_artifacts() {
        if skip_if_missing(&path, label) {
            return;
        }
    }
    let tmp = tempfile::TempDir::new().expect("tmpdir");
    let files = emit_pack_for_fixture(tmp.path());
    println!("===== BEGIN EXPECTED_PACK_HASHES =====");
    for (name, body) in &files {
        println!(
            "    (\"{}\", \"{}\"),",
            name,
            sha256_hex(body)
        );
    }
    println!("===== END EXPECTED_PACK_HASHES =====");
    if std::env::var("RIPTIDE_DUMP_EXPECTED_CONTENT").ok().as_deref() == Some("1") {
        for (name, body) in &files {
            println!("\n===== {name} =====");
            println!("{}", String::from_utf8_lossy(body));
        }
    }
}

#[test]
fn pack_is_byte_identical_across_runs() {
    for (path, label) in required_artifacts() {
        if skip_if_missing(&path, label) {
            return;
        }
    }
    let tmp_a = tempfile::TempDir::new().expect("tmpdir");
    let tmp_b = tempfile::TempDir::new().expect("tmpdir");
    let first = emit_pack_for_fixture(tmp_a.path());
    let second = emit_pack_for_fixture(tmp_b.path());
    assert_eq!(
        first, second,
        "pack emission must be byte-identical across runs"
    );
}

#[test]
fn pack_hashes_match_pinned_expectations() {
    for (path, label) in required_artifacts() {
        if skip_if_missing(&path, label) {
            return;
        }
    }
    // Skip if the expected table still carries placeholders — the
    // dump test populates it. This keeps CI green on the first
    // commit that introduces the file; the second commit pastes
    // the real hashes in.
    if EXPECTED_PACK_HASHES
        .iter()
        .any(|(_, hash)| *hash == "__PLACEHOLDER__")
    {
        eprintln!(
            "skipping pack_hashes_match_pinned_expectations: \
             EXPECTED_PACK_HASHES still contains __PLACEHOLDER__. \
             Run with RIPTIDE_DUMP_EXPECTED=1 to populate."
        );
        return;
    }

    let tmp = tempfile::TempDir::new().expect("tmpdir");
    let files = emit_pack_for_fixture(tmp.path());

    let actual: BTreeMap<String, String> = files
        .iter()
        .map(|(name, body)| (name.clone(), sha256_hex(body)))
        .collect();
    let expected: BTreeMap<String, String> = EXPECTED_PACK_HASHES
        .iter()
        .map(|(name, hash)| ((*name).to_string(), (*hash).to_string()))
        .collect();

    assert_eq!(
        actual.keys().collect::<Vec<_>>(),
        expected.keys().collect::<Vec<_>>(),
        "pack file layout drifted from pinned set"
    );

    for (name, hash) in &actual {
        assert_eq!(
            expected.get(name),
            Some(hash),
            "pack file `{name}` hash drifted — regenerate with RIPTIDE_DUMP_EXPECTED=1 if intentional",
        );
    }

    // The Sprint 11 canonical hash must land inside the pack
    // manifest byte-identically — the pack never fabricates a new
    // hash, it just surfaces the one the SimulationResult carries.
    let manifest_body = files
        .iter()
        .find(|(n, _)| n == "manifest.json")
        .map(|(_, b)| String::from_utf8_lossy(b).into_owned())
        .expect("pack has manifest.json");
    assert!(
        manifest_body
            .contains("d04feab99390d63de6625bad4994a05e89cede359b4599431e815fe327cd0aeb"),
        "manifest.json must carry the Sprint 11 canonical hash verbatim; body=\n{manifest_body}",
    );
}

#[test]
fn pack_carries_no_absolute_or_tmp_paths() {
    for (path, label) in required_artifacts() {
        if skip_if_missing(&path, label) {
            return;
        }
    }
    let tmp = tempfile::TempDir::new().expect("tmpdir");
    let files = emit_pack_for_fixture(tmp.path());
    for (name, body) in &files {
        let text = String::from_utf8_lossy(body);
        for needle in &["/home/", "/Users/", "/tmp/", "/var/folders/"] {
            assert!(
                !text.contains(needle),
                "pack file `{name}` contains forbidden `{needle}` — forwardability broken",
            );
        }
    }
}

#[test]
fn pack_carries_evidence_disclaimer() {
    for (path, label) in required_artifacts() {
        if skip_if_missing(&path, label) {
            return;
        }
    }
    let tmp = tempfile::TempDir::new().expect("tmpdir");
    let files = emit_pack_for_fixture(tmp.path());
    for target in &["summary.md", "trace.md", "rerun.sh"] {
        let entry = files
            .iter()
            .find(|(n, _)| n == target)
            .unwrap_or_else(|| panic!("pack missing {target}"));
        let text = String::from_utf8_lossy(&entry.1);
        assert!(
            text.contains("Simulation evidence"),
            "{target} missing `Simulation evidence` disclaimer",
        );
    }
}

#[test]
fn rerun_sh_rejects_shell_metacharacter_injection() {
    // Regression gate for F-2026-04-21-S12P1-001: a forwarded pack
    // must never execute `$(...)`, backtick, or `${...}` expansions
    // on the reviewer's machine. The emit_pack leak scanner runs
    // at emission time, so we drive an injection through a
    // command_hint and assert the emission bails rather than
    // silently writing a poisoned rerun.sh.
    let tmp = tempfile::TempDir::new().expect("tmpdir");
    let repo = monorepo_root();

    // Build a minimal SimulationResult to exercise the renderer.
    // We're not asserting on pack content; we're asserting emission
    // refuses to land an unsafe rerun.sh.
    let result = riptide_engine::types::SimulationResult {
        run_config: riptide_engine::types::RunConfig {
            agents: 1,
            ticks: 1,
            scenario: "injection-probe".into(),
            seed: 0,
            personas: Vec::new(),
            validator_url: "http://127.0.0.1:8899".into(),
            output_path: "riptide-output/injection-probe/simulation-result.json".into(),
        },
        seed: 0,
        total_ticks: 1,
        timeseries: Vec::new(),
        events: Vec::new(),
        agents: Vec::new(),
        summary: Default::default(),
        simulation_boundaries: Vec::new(),
    };

    let options = PackEmitOptions {
        repo_root: repo.clone(),
        pack_dir: tmp.path().to_path_buf(),
        // Intentionally unsafe: a caller passing a command_hint
        // that carries `$(id)` would previously land verbatim into
        // rerun.sh. The scanner must bail.
        command_hint: Some(
            "exec riptide replay \"fixtures/$(id).toml\"".to_string(),
        ),
        adapter_display: None,
    };

    let pack_dir = tmp.path().to_path_buf();
    let err = emit_pack(
        &result,
        &PackInputs::default(),
        &PackOutputs::default(),
        &options,
    )
    .expect_err("emit_pack must reject a command_hint carrying command substitution");
    let msg = format!("{err:#}");
    assert!(
        msg.contains("shell-injection risk"),
        "expected shell-injection bail, got: {msg}"
    );
    assert!(
        msg.contains("rerun.sh"),
        "expected rerun.sh named in the diagnostic, got: {msg}"
    );
    // Defense in depth: the partial (poisoned) pack MUST be scrubbed
    // from disk so a retrying caller or curious reviewer never
    // inherits the unsafe rerun.sh left behind by the failed emit.
    assert!(
        !pack_dir.exists(),
        "partial pack dir {} survived a scanner bail — poisoned rerun.sh could be executed",
        pack_dir.display()
    );
}

#[test]
fn trace_surfaces_qualified_cross_component_keys() {
    for (path, label) in required_artifacts() {
        if skip_if_missing(&path, label) {
            return;
        }
    }
    let tmp = tempfile::TempDir::new().expect("tmpdir");
    let files = emit_pack_for_fixture(tmp.path());
    let trace = files
        .iter()
        .find(|(n, _)| n == "trace.md")
        .map(|(_, b)| String::from_utf8_lossy(b).into_owned())
        .expect("pack has trace.md");

    // The qualified keys Sprint 11 pinned in the expected-summary
    // fixture must appear in trace.md verbatim, so a reviewer can
    // tie upstream depeg to downstream bad debt without opening
    // simulation-result.json.
    for key in &[
        "liquid_staking:no_slash_during_healthy_run",
        "lending:no_bad_debt",
        "pool.exchange_rate_bps",
        "pool.bad_debt",
        "lst_exchange_rate_to_lending_oracle",
    ] {
        assert!(
            trace.contains(key),
            "trace.md missing qualified key `{key}` — reviewer context broken\n\n{trace}",
        );
    }
}
