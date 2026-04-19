//! T23 — Real Pyth Borsh layout (Sprint 6 Phase 0 · T02 gate).
//!
//! Validates that `PythMockOracleLayout::encode` produces bytes a
//! program built against `pyth-sdk-solana` would parse cleanly via
//! `load_price_feed_from_account_info`'s aggregate-price read path.
//!
//! **Test strategy:** rather than dragging `pyth-sdk-solana` into the
//! engine's dev-dep tree (which would conflict with the engine's pinned
//! `solana-program`/`solana-sdk` versions), we mirror the minimum
//! subset of `GenericPriceAccount<32, ()>`'s `#[repr(C)]` layout
//! locally and verify:
//!
//! 1. The byte offsets the encoder writes match the Pyth spec exactly
//!    (magic, ver, atype, expo, agg.price, agg.conf, agg.status,
//!    agg.pub_slot).
//! 2. A locally-mirrored Pod struct reads back the same values via a
//!    transmute — this is structurally identical to what
//!    `bytemuck::from_bytes` does inside `pyth-sdk-solana`'s
//!    `load_price_account`.
//! 3. Round-trip equality: `encode → decode → encode` produces
//!    byte-identical output.
//! 4. Admin-mock layout is unaffected — its byte layout + fixture
//!    golden file stay green.
//!
//! Sprint 6 cut criterion (per the task note): if the Pyth layout
//! eats >2 days, cut the task and ship admin-mock as the shipping
//! oracle for Sprint 6. The byte-offset approach here lands in <1
//! day and does not require an SBF program addition, so T02 ships.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use riptide_engine::adapter::OracleKind;
use riptide_engine::scenario::oracle::{
    oracle_layout_for, AdminMockOracleLayout, OracleLayout, OracleUpdate, PYTH_ACCOUNT_SIZE,
    PYTH_ATYPE_PRICE, PYTH_MAGIC, PYTH_OFFSET_AGG_CONF, PYTH_OFFSET_AGG_PRICE,
    PYTH_OFFSET_AGG_PUB_SLOT, PYTH_OFFSET_AGG_STATUS, PYTH_OFFSET_ATYPE, PYTH_OFFSET_EXPO,
    PYTH_OFFSET_MAGIC, PYTH_OFFSET_VER, PYTH_STATUS_TRADING, PYTH_VERSION,
    PythMockOracleLayout,
};

/// Mirror of `pyth-sdk-solana::PriceInfo`. `#[repr(C)]` matches the
/// upstream declaration; bytemuck Pod cast via direct transmute in the
/// test below.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct MockPriceInfo {
    price: i64,
    conf: u64,
    status: u8,
    corp_act: u8,
    _pad: [u8; 6],
    pub_slot: u64,
}

/// Minimum prefix of `pyth-sdk-solana::GenericPriceAccount<32, ()>`
/// needed for the aggregate-price read path. `#[repr(C)]` layout
/// matches the upstream struct byte-for-byte up through `agg`.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct MockPriceAccountPrefix {
    magic: u32,
    ver: u32,
    atype: u32,
    size: u32,
    ptype: u8,
    _pad0: [u8; 3],
    expo: i32,
    num: u32,
    num_qt: u32,
    last_slot: u64,
    valid_slot: u64,
    ema_price: [i64; 3],
    ema_conf: [i64; 3],
    timestamp: i64,
    min_pub: u8,
    drv2: u8,
    drv3: u16,
    drv4: u32,
    prod: [u8; 32],
    next: [u8; 32],
    prev_slot: u64,
    prev_price: i64,
    prev_conf: u64,
    prev_timestamp: i64,
    agg: MockPriceInfo,
}

const MOCK_PREFIX_SIZE: usize = std::mem::size_of::<MockPriceAccountPrefix>();

#[test]
fn mirror_prefix_matches_agg_offset() {
    // Load-bearing sanity check on the mirror struct. If Rust ever
    // changes `repr(C)` padding or the upstream Pyth struct adds a
    // field, this test pins the invariant: `agg.price` must land at
    // offset 0xD0 inside the prefix. Sprint 6 encoder writes to
    // `PYTH_OFFSET_AGG_PRICE = 0xD0`.
    assert_eq!(
        std::mem::offset_of!(MockPriceAccountPrefix, agg),
        PYTH_OFFSET_AGG_PRICE,
        "mirror `agg` offset drifted from Pyth spec — if the upstream struct changed, update \
         both scenario/oracle.rs and this mirror in lock-step"
    );
    assert_eq!(MOCK_PREFIX_SIZE, PYTH_OFFSET_AGG_PUB_SLOT + 8);
}

#[test]
fn pyth_encode_matches_declared_byte_offsets() {
    let layout = PythMockOracleLayout;
    let update = OracleUpdate {
        price: 123.45,
        exponent: -2,
    };
    let bytes = layout.encode([0u8; 32], &update).unwrap();
    assert_eq!(bytes.len(), PYTH_ACCOUNT_SIZE, "pyth account must be 3312 bytes");

    // Header validation constants at the exact offsets Pyth expects.
    assert_eq!(
        u32::from_le_bytes(bytes[PYTH_OFFSET_MAGIC..PYTH_OFFSET_MAGIC + 4].try_into().unwrap()),
        PYTH_MAGIC,
        "magic 0xa1b2c3d4 at offset 0x00"
    );
    assert_eq!(
        u32::from_le_bytes(bytes[PYTH_OFFSET_VER..PYTH_OFFSET_VER + 4].try_into().unwrap()),
        PYTH_VERSION,
        "ver == 2 at offset 0x04"
    );
    assert_eq!(
        u32::from_le_bytes(bytes[PYTH_OFFSET_ATYPE..PYTH_OFFSET_ATYPE + 4].try_into().unwrap()),
        PYTH_ATYPE_PRICE,
        "atype == 3 (Price) at offset 0x08"
    );

    // expo at 0x14 as i32 little-endian.
    assert_eq!(
        i32::from_le_bytes(bytes[PYTH_OFFSET_EXPO..PYTH_OFFSET_EXPO + 4].try_into().unwrap()),
        -2,
        "expo at offset 0x14"
    );

    // Aggregate sub-struct — the read path Pyth programs hit in
    // `to_price_feed`.
    let agg_price = i64::from_le_bytes(
        bytes[PYTH_OFFSET_AGG_PRICE..PYTH_OFFSET_AGG_PRICE + 8]
            .try_into()
            .unwrap(),
    );
    // 123.45 × 10^2 == 12345 when exponent = -2.
    assert_eq!(agg_price, 12345, "agg.price at offset 0xD0");
    assert_eq!(
        u64::from_le_bytes(bytes[PYTH_OFFSET_AGG_CONF..PYTH_OFFSET_AGG_CONF + 8].try_into().unwrap()),
        0,
        "agg.conf at offset 0xD8 (Sprint 6 zero-fill)"
    );
    assert_eq!(
        bytes[PYTH_OFFSET_AGG_STATUS],
        PYTH_STATUS_TRADING,
        "agg.status at offset 0xE0 (Trading so readers don't fall through to prev_*)"
    );
    assert_eq!(
        u64::from_le_bytes(bytes[PYTH_OFFSET_AGG_PUB_SLOT..PYTH_OFFSET_AGG_PUB_SLOT + 8].try_into().unwrap()),
        0,
        "agg.pub_slot at offset 0xE8 (Sprint 6 zero-fill)"
    );
}

#[test]
fn pyth_bytes_parse_through_mirror_pod_cast() {
    // Byte-for-byte structural equivalence with Pyth's `Pod` cast. If
    // the engine's bytes were mis-aligned for `#[repr(C)]`, this cast
    // would read wrong values. The fact that values round-trip cleanly
    // through a locally-declared mirror struct proves any
    // `pyth-sdk-solana` reader using the same repr will read the same
    // values.
    let layout = PythMockOracleLayout;
    let update = OracleUpdate {
        price: 250.0,
        exponent: -1,
    };
    let bytes = layout.encode([0u8; 32], &update).unwrap();
    assert_eq!(bytes.len(), PYTH_ACCOUNT_SIZE);

    // SAFETY: `MockPriceAccountPrefix` is `#[repr(C)]`, all fields
    // are integer / fixed-byte arrays (no references, no padding-
    // sensitive enums), so reading the prefix as this struct is safe
    // as long as the buffer is at least MOCK_PREFIX_SIZE long. We
    // already asserted PYTH_ACCOUNT_SIZE > MOCK_PREFIX_SIZE above.
    let prefix_ptr = bytes.as_ptr() as *const MockPriceAccountPrefix;
    let prefix = unsafe { std::ptr::read_unaligned(prefix_ptr) };

    assert_eq!(prefix.magic, PYTH_MAGIC);
    assert_eq!(prefix.ver, PYTH_VERSION);
    assert_eq!(prefix.atype, PYTH_ATYPE_PRICE);
    assert_eq!(prefix.expo, -1);
    assert_eq!(prefix.agg.price, 2500, "250.0 × 10^1 = 2500 (expo=-1)");
    assert_eq!(prefix.agg.conf, 0);
    assert_eq!(prefix.agg.status, PYTH_STATUS_TRADING);
    assert_eq!(prefix.agg.pub_slot, 0);
}

#[test]
fn pyth_encode_decode_roundtrip() {
    let layout = PythMockOracleLayout;
    for (price, exponent) in [
        (100.0_f64, 0_i8),
        (99.999_f64, -3_i8),
        (1.0_f64, -8_i8),
        (1_000_000.0_f64, 0_i8),
    ] {
        let update = OracleUpdate { price, exponent };
        let bytes = layout.encode([0u8; 32], &update).unwrap();
        let decoded = layout.decode(&bytes).unwrap();
        assert_eq!(decoded.exponent, exponent, "exponent roundtrip");
        // Price round-trips within float-quantization tolerance of
        // the integer representation.
        let quantum = 10f64.powi(i32::from(exponent));
        assert!(
            (decoded.price - price).abs() <= quantum.abs() * 1.0,
            "price roundtrip: encoded {price}, decoded {}, quantum {quantum}",
            decoded.price
        );
    }
}

#[test]
fn pyth_encode_is_byte_deterministic() {
    let layout = PythMockOracleLayout;
    let update = OracleUpdate {
        price: 42.24,
        exponent: -2,
    };
    let bytes_a = layout.encode([0u8; 32], &update).unwrap();
    let bytes_b = layout.encode([0u8; 32], &update).unwrap();
    assert_eq!(bytes_a, bytes_b, "same input must produce same bytes");
}

#[test]
fn pyth_decode_rejects_wrong_magic() {
    let layout = PythMockOracleLayout;
    let mut bytes = layout
        .encode(
            [0u8; 32],
            &OracleUpdate {
                price: 10.0,
                exponent: 0,
            },
        )
        .unwrap();
    bytes[0] = 0xde; // corrupt magic
    let err = layout.decode(&bytes).unwrap_err();
    assert!(
        err.to_string().contains("magic mismatch"),
        "expected magic-mismatch diagnostic, got: {err}"
    );
}

#[test]
fn pyth_dispatch_through_oracle_kind_selector() {
    // Regression: `oracle_layout_for(OracleKind::Pyth)` now returns
    // our real layout (3312 bytes), not the admin-mock alias (50
    // bytes) that Sprint 5 shipped. A generic adapter declaring
    // `kind = "pyth"` gets real Pyth bytes written through this
    // dispatch path.
    let boxed = oracle_layout_for(OracleKind::Pyth);
    assert_eq!(boxed.byte_len(), PYTH_ACCOUNT_SIZE, "Pyth kind dispatches to Pyth layout");

    let boxed = oracle_layout_for(OracleKind::AdminMock);
    assert_eq!(
        boxed.byte_len(),
        AdminMockOracleLayout.byte_len(),
        "AdminMock kind still dispatches to admin-mock layout (50 bytes)"
    );
}

/// Repo root (parent of the engine crate) — anchor for locating the
/// sibling `pyth_consumer_test_helper` crate.
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("engine has a parent directory")
        .to_path_buf()
}

/// Scan the helper crate's cargo output paths for a pre-built binary.
/// Returns `None` if neither release nor debug artifact exists yet.
fn find_pyth_consumer_helper_bin() -> Option<PathBuf> {
    let root = repo_root();
    let candidates = [
        root.join("programs/pyth_consumer_test_helper/target/release/pyth-consumer-test-helper"),
        root.join("programs/pyth_consumer_test_helper/target/debug/pyth-consumer-test-helper"),
    ];
    for candidate in candidates {
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

/// **Enforced T02 gate** — locate the helper binary, building it in-
/// process on a fresh checkout if necessary. `cargo test` on a clean
/// tree goes green ONLY if the real-SDK path actually ran; absence of
/// the helper no longer masquerades as "test skipped".
///
/// Build cost: ~50s cold (the helper pulls the full legacy borsh 0.10
/// / solana-program 1.18 world). Cached after the first run under
/// `programs/pyth_consumer_test_helper/target/`. We use a process-level
/// `OnceLock` so the build runs at most once per `cargo test`
/// invocation even when multiple t23 tests exercise the helper.
///
/// Failure modes — all panic with a clear message so the developer
/// knows T02 is actually broken (vs. a silent skip masking a regression):
///   - `cargo build` subprocess fails → helper crate won't compile.
///   - `cargo build` succeeds but output binary is missing → infra
///     mismatch between helper's Cargo.toml and what this scan
///     expects.
fn ensure_pyth_consumer_helper_bin() -> PathBuf {
    use std::sync::OnceLock;
    static HELPER: OnceLock<PathBuf> = OnceLock::new();
    HELPER
        .get_or_init(|| {
            if let Some(existing) = find_pyth_consumer_helper_bin() {
                return existing;
            }
            let root = repo_root();
            let manifest = root.join("programs/pyth_consumer_test_helper/Cargo.toml");
            eprintln!(
                "T23 gate: building pyth-consumer-test-helper (first run / clean checkout)..."
            );
            eprintln!("  manifest: {}", manifest.display());
            let status = Command::new("cargo")
                .args(["build", "--release", "--manifest-path"])
                .arg(&manifest)
                .status()
                .unwrap_or_else(|e| {
                    panic!(
                        "T23 gate: failed to spawn cargo for pyth-consumer-test-helper build: {e}"
                    )
                });
            assert!(
                status.success(),
                "T23 gate: pyth-consumer-test-helper build FAILED — the real Pyth-SDK \
                 consumer is load-bearing for the Sprint 6 T02 contract. Fix the build \
                 before continuing:\n  \
                 cargo build --release --manifest-path programs/pyth_consumer_test_helper/Cargo.toml"
            );
            find_pyth_consumer_helper_bin().expect(
                "T23 gate: cargo build reported success but no helper binary was produced at \
                 programs/pyth_consumer_test_helper/target/release/pyth-consumer-test-helper. Check the \
                 helper crate's Cargo.toml [[bin]] target name.",
            )
        })
        .clone()
}

fn run_pyth_consumer_helper(bytes: &[u8]) -> serde_json::Value {
    let bin = ensure_pyth_consumer_helper_bin();
    let mut child = Command::new(&bin)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn pyth-consumer-test-helper");
    child
        .stdin
        .as_mut()
        .expect("stdin piped")
        .write_all(bytes)
        .expect("write bytes to helper");
    let output = child
        .wait_with_output()
        .expect("wait for pyth-consumer-test-helper");
    assert!(
        output.status.success(),
        "pyth-consumer-test-helper exited {:?}; stderr:\n{}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("helper stdout is utf8");
    let trimmed = stdout.trim();
    serde_json::from_str(trimmed).unwrap_or_else(|e| {
        panic!("helper stdout is not JSON: {e}; raw: {trimmed:?}")
    })
}

/// **The literal Sprint 6 acceptance criterion** (tasks.md:37): a
/// test that calls the real `pyth-sdk-solana` read API on our mocked
/// bytes and sees the encoded values back, unchanged.
///
/// Parses the mocked account through `pyth-sdk-solana 0.10.6`'s
/// `load_price_account::<32, ()>` (the function
/// `load_price_feed_from_account_info` dispatches to internally) and
/// asserts the returned `SolanaPriceAccount.{agg.price,agg.conf,expo,
/// agg.pub_slot,agg.status,ema_price.val,magic,ver,atype}` match what
/// our encoder wrote.
///
/// **Hard-gate:** the helper binary is isolated in a separate crate
/// outside the workspace because pyth-sdk-solana 0.10's borsh 0.10
/// fundamentally conflicts with the engine's borsh 1.6 / solana-sdk
/// 4.0.1 world — see the helper's Cargo.toml for the full rationale.
/// `ensure_pyth_consumer_helper_bin` builds the helper in-process on
/// the first test invocation, so `cargo test` on a fresh checkout
/// genuinely exercises the real-SDK path (not a silent skip).
/// Cached after the first run under `programs/pyth_consumer_test_helper/target/`.
#[test]
fn pyth_sdk_solana_parses_our_mock_unchanged() {
    // `run_pyth_consumer_helper` internally calls
    // `ensure_pyth_consumer_helper_bin`, which auto-builds on a fresh
    // checkout and panics loudly on build failure. There is no skip
    // path — if the helper can't build, T02's contract is broken and
    // the test must fail.
    let layout = PythMockOracleLayout;
    let update = OracleUpdate {
        price: 987.65,
        exponent: -2,
    };
    let bytes = layout.encode([0u8; 32], &update).unwrap();

    let parsed = run_pyth_consumer_helper(&bytes);

    // Magic / version / atype gates — if these are wrong, pyth-sdk-solana
    // itself would have rejected the bytes before we got here, so the
    // helper's successful exit is already strong evidence. Asserting
    // them explicitly pins the intent.
    assert_eq!(parsed["magic"].as_u64().unwrap() as u32, PYTH_MAGIC);
    assert_eq!(parsed["version"].as_u64().unwrap() as u32, PYTH_VERSION);
    assert_eq!(
        parsed["account_type"].as_u64().unwrap() as u32,
        PYTH_ATYPE_PRICE
    );

    // Aggregate-price read path — the actual Sprint 6 contract.
    assert_eq!(
        parsed["price"].as_i64().unwrap(),
        98_765,
        "agg.price: 987.65 * 10^2 = 98765 (expo=-2)"
    );
    assert_eq!(parsed["conf"].as_u64().unwrap(), 0, "agg.conf");
    assert_eq!(parsed["expo"].as_i64().unwrap(), -2, "expo");
    assert_eq!(parsed["publish_slot"].as_u64().unwrap(), 0, "agg.pub_slot");
    assert_eq!(
        parsed["status"].as_str().unwrap(),
        "Trading",
        "agg.status — must be Trading so Pyth readers don't fall through to prev_*"
    );
    // ema_price.val is populated with agg.price as a safety-fallback
    // stand-in — programs that sanity-check EMA against aggregate see
    // a sensible value rather than zero.
    assert_eq!(parsed["ema_price"].as_i64().unwrap(), 98_765);
}

#[test]
fn pyth_sdk_solana_parses_multiple_exponents() {
    // Hard-gated via run_pyth_consumer_helper → auto-build path.
    let layout = PythMockOracleLayout;
    let cases = [
        (100.0_f64, 0_i8, 100_i64),
        (1.0_f64, -8_i8, 100_000_000_i64),
        (1_000_000.0_f64, 0_i8, 1_000_000_i64),
        (50.25_f64, -4_i8, 502_500_i64),
    ];
    for (price, exponent, expected_agg) in cases {
        let update = OracleUpdate { price, exponent };
        let bytes = layout.encode([0u8; 32], &update).unwrap();
        let parsed = run_pyth_consumer_helper(&bytes);
        assert_eq!(
            parsed["expo"].as_i64().unwrap() as i8,
            exponent,
            "expo roundtrip for {price:?}"
        );
        assert_eq!(
            parsed["price"].as_i64().unwrap(),
            expected_agg,
            "agg.price for {price:?}×10^{}",
            -exponent
        );
        assert_eq!(parsed["status"].as_str().unwrap(), "Trading");
    }
}

#[test]
fn admin_mock_layout_untouched_by_pyth_drop() {
    // Sprint 4 determinism contract: admin-mock bytes are identical
    // to the Sprint 5 shipping layout. Regenerating the hero grid
    // depends on this — the Sprint 4 w25-s40 hash check would fail
    // otherwise.
    let layout = AdminMockOracleLayout;
    assert_eq!(layout.byte_len(), 50, "admin-mock layout stays at 50 bytes");
    let bytes = layout
        .encode(
            [7u8; 32],
            &OracleUpdate {
                price: 123.0,
                exponent: -2,
            },
        )
        .unwrap();
    assert_eq!(bytes.len(), 50);
    let decoded = layout.decode(&bytes).unwrap();
    assert_eq!(decoded.exponent, -2);
    assert!((decoded.price - 123.0).abs() < 1e-9);
}
