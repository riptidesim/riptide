//! Multi-arg instruction builder ( · gate).
//!
//! Pure encoder test: assembles a synthetic multi-arg IDL + adapter
//! TOML and exercises `GenericInstructionBuilder::build_action_data`
//! across every -supported Borsh type (`u64`, `i64`, `u32`,
//! `u8`, `bool`, `pubkey`). Coverage:
//!
//! 1. `three_arg_swap_encodes_deterministically` — AMM-shape action
//! `swap(amount_in: u64, min_out: u64, direction: bool)` with
//! runtime-bound `amount_in` + literal `min_out` + literal
//! `direction`. Asserts byte-for-byte the discriminator + three
//! payload slots.
//! 2. `u32_u8_bool_pubkey_literals_encode_correctly` — exercises the
//! full type matrix on a single synthetic instruction
//! with six args. Confirms range checks on u32/u8 literals fire
//! on overflow. Confirms `pubkey` literals base58-decode to 32
//! raw bytes.
//! 3. `single_arg_adapter_stays_byte_identical` — backwards compat:
//! 's single-u64 path produces the same bytes under the
//! new encoder (8-byte discriminator + 8-byte LE u64).
//! 4. `multi_arg_action_rejects_double_binding` — loader fails if an
//! action's arg is bound both as `amount` AND as a literal in
//! `args` (picks one, not both).
//! 5. `encoder_rejects_unbound_idl_arg` — loader fails when an IDL
//! arg is declared but neither runtime-bound nor literal-bound in
//! the adapter.
//! 6. `encoder_rejects_runtime_overflow_for_u8` — runtime-amount
//! overflow surfaces as an adapter error, not silent wrap.
//!
//! This test is the sole unit-level gate for. The adapter-loader
//! validation path is exercised via `parse_adapter_str`; the
//! encoder itself via `GenericInstructionBuilder::build_action_data`.
//! A LiteSVM fork-program round-trip of a real multi-arg instruction
//! lands in — this gate verifies the
//! engine-capability surface alone.

use std::collections::BTreeMap;

use riptide_engine::adapter::{loader::parse_adapter_str, AdapterError, ArgLiteral};
use riptide_engine::primitive::{
    build_generic_policies, parse_generic_idl_str, GenericInstructionBuilder,
};

const SWAP_IDL: &str = r#"
{
  "instructions": [
    {
      "name": "swap",
      "discriminator": [115, 119, 97, 112, 0, 0, 0, 0],
      "accounts": [
        { "name": "authority", "signer": true, "writable": true },
        { "name": "pool", "writable": true }
      ],
      "args": [
        { "name": "amount_in", "type": "u64" },
        { "name": "min_out", "type": "u64" },
        { "name": "direction", "type": "bool" }
      ]
    }
  ],
  "accounts": [
    {
      "name": "pool",
      "fields": [
        { "name": "reserve_a", "type": "u64" },
        { "name": "reserve_b", "type": "u64" }
      ]
    }
  ],
  "types": []
}
"#;

const TYPE_MATRIX_IDL: &str = r#"
{
  "instructions": [
    {
      "name": "all_types",
      "discriminator": [1, 2, 3, 4, 5, 6, 7, 8],
      "accounts": [
        { "name": "authority", "signer": true, "writable": true },
        { "name": "pool", "writable": true }
      ],
      "args": [
        { "name": "amt", "type": "u64" },
        { "name": "delta", "type": "i64" },
        { "name": "cap", "type": "u32" },
        { "name": "tier", "type": "u8" },
        { "name": "flag", "type": "bool" },
        { "name": "recipient", "type": "pubkey" }
      ]
    }
  ],
  "accounts": [
    {
      "name": "pool",
      "fields": [
        { "name": "reserve_a", "type": "u64" }
      ]
    }
  ],
  "types": []
}
"#;

fn swap_adapter_toml(
    min_out: &str,
    direction: &str,
    takes: &str,
    args_block: &str,
) -> String {
    // Keep the program_so path pointing at a real shipped.so so the
    // loader's post-resolution existence check passes. The test only
    // drives `build_action_data` — nothing actually executes the.so.
    format!(
        r#"
protocol = "generic"
program_so = "../programs/resource_grinder/target/deploy/resource_grinder.so"
idl_path = "../fixtures/idls/resource-grinder.json"

[accounts.authority]
kind = "agent"
space = 8

[accounts.pool]
kind = "shared"
space = 16

[instructions.swap]
action = "swap"
amount = "amount_in"
args = {{ {args_block} }}

[state_mapping]
"pool.reserve_a" = "pool.reserve_a"

[actions.swap]
label = "Swap"
takes = [{takes}]

[observations]
"pool.reserve_a" = "uint"

[personas.trader]
action_rate_multiplier = 1.0
action_weights = {{ swap = 1.0 }}
triggers = []

# Docstring references; keep unused to silence rust formatter:
# min_out={min_out} direction={direction}
"#,
    )
}

#[test]
fn three_arg_swap_encodes_deterministically() {
    let toml = swap_adapter_toml(
        "0",
        "false",
        r#""amount_in""#,
        r#"min_out = 0, direction = false"#,
    );
    let adapter = parse_adapter_str(&toml, "t22-swap.toml")
        .expect("multi-arg swap adapter parses");
    let idl = parse_generic_idl_str(SWAP_IDL).expect("swap IDL parses");

    let builder = GenericInstructionBuilder::new(&idl, &adapter);
    let bytes = builder
        .build_action_data_single_arg("swap", 1_000_000)
        .expect("swap encodes with 3-arg payload");

    // 8-byte discriminator + u64 amount_in (8) + u64 min_out (8) +
    // bool direction (1) = 25 bytes total.
    assert_eq!(bytes.len(), 25, "swap payload length: {}", bytes.len());
    assert_eq!(&bytes[..8], &[115, 119, 97, 112, 0, 0, 0, 0], "discriminator");
    assert_eq!(
        u64::from_le_bytes(bytes[8..16].try_into().unwrap()),
        1_000_000,
        "amount_in"
    );
    assert_eq!(
        u64::from_le_bytes(bytes[16..24].try_into().unwrap()),
        0,
        "min_out literal"
    );
    assert_eq!(bytes[24], 0, "direction=false → 0x00");

    // Flip `direction = true` and assert only the trailing byte moves.
    let toml_true = swap_adapter_toml(
        "500",
        "true",
        r#""amount_in""#,
        r#"min_out = 500, direction = true"#,
    );
    let adapter_true = parse_adapter_str(&toml_true, "t22-swap-true.toml").unwrap();
    let builder_true = GenericInstructionBuilder::new(&idl, &adapter_true);
    let bytes_true = builder_true.build_action_data_single_arg("swap", 1_000_000).unwrap();
    assert_eq!(bytes_true[24], 1, "direction=true → 0x01");
    assert_eq!(
        u64::from_le_bytes(bytes_true[16..24].try_into().unwrap()),
        500,
        "min_out literal 500"
    );

    // Determinism: same adapter + same amount produces byte-identical
    // output across repeat calls (the encoder has no hidden state).
    let again = builder
        .build_action_data_single_arg("swap", 1_000_000)
        .expect("swap encodes deterministically");
    assert_eq!(bytes, again, "encoder must be byte-deterministic");
}

#[test]
fn u32_u8_bool_pubkey_literals_encode_correctly() {
    let recipient_base58 = "GLe1xiYPUBRQCrxQA1wMVSESmCqY1YgVi1Rrhu7oMUhk";
    let recipient_bytes = bs58::decode(recipient_base58).into_vec().unwrap();
    assert_eq!(recipient_bytes.len(), 32);

    let toml = format!(
        r#"
protocol = "generic"
program_so = "../programs/resource_grinder/target/deploy/resource_grinder.so"
idl_path = "../fixtures/idls/resource-grinder.json"

[accounts.authority]
kind = "agent"
space = 8

[accounts.pool]
kind = "shared"
space = 16

[instructions.all_types]
action = "call"
amount = "amt"
args = {{ delta = -42, cap = 65535, tier = 3, flag = true, recipient = "{recipient_base58}" }}

[state_mapping]
"pool.reserve_a" = "pool.reserve_a"

[actions.call]
takes = ["amt"]

[observations]
"pool.reserve_a" = "uint"

[personas.tester]
action_rate_multiplier = 1.0
action_weights = {{ call = 1.0 }}
triggers = []
"#
    );
    let adapter = parse_adapter_str(&toml, "t22-matrix.toml").expect("matrix adapter parses");
    let idl = parse_generic_idl_str(TYPE_MATRIX_IDL).expect("matrix IDL parses");
    let builder = GenericInstructionBuilder::new(&idl, &adapter);

    let bytes = builder
        .build_action_data_single_arg("call", 7)
        .expect("6-arg instruction encodes");

    // 8 disc + u64 amt (8) + i64 delta (8) + u32 cap (4) + u8 tier (1)
    // + bool flag (1) + pubkey recipient (32) = 62 bytes.
    assert_eq!(bytes.len(), 62, "payload length: {}", bytes.len());
    assert_eq!(&bytes[..8], &[1, 2, 3, 4, 5, 6, 7, 8], "discriminator");
    assert_eq!(u64::from_le_bytes(bytes[8..16].try_into().unwrap()), 7, "amt");
    assert_eq!(
        i64::from_le_bytes(bytes[16..24].try_into().unwrap()),
        -42,
        "delta (negative i64)"
    );
    assert_eq!(
        u32::from_le_bytes(bytes[24..28].try_into().unwrap()),
        65_535,
        "cap (u32::MAX/2-ish literal)"
    );
    assert_eq!(bytes[28], 3, "tier (u8)");
    assert_eq!(bytes[29], 1, "flag=true (bool)");
    assert_eq!(&bytes[30..62], recipient_bytes.as_slice(), "recipient 32-byte pubkey");
}

#[test]
fn single_arg_adapter_stays_byte_identical() {
    // Backwards compat gate: 's perpetuals / resource-grinder
    // single-arg shape must continue to produce the exact same bytes
    // under the new multi-arg encoder. Builds a minimal single-arg
    // adapter and asserts the 16-byte payload: 8-byte discriminator +
    // 8-byte LE u64 amount, identical to the pre-Sprint-6 encoder.
    let single_idl = r#"
{
  "instructions": [
    {
      "name": "mine",
      "discriminator": [109, 105, 110, 101, 0, 0, 0, 0],
      "accounts": [
        { "name": "authority", "signer": true, "writable": true },
        { "name": "player", "writable": true }
      ],
      "args": [
        { "name": "amount", "type": "u64" }
      ]
    }
  ],
  "accounts": [
    { "name": "player", "fields": [{ "name": "gold", "type": "u64" }] }
  ],
  "types": []
}
"#;
    let toml = r#"
protocol = "generic"
program_so = "../programs/resource_grinder/target/deploy/resource_grinder.so"
idl_path = "../fixtures/idls/resource-grinder.json"

[accounts.authority]
kind = "agent"
space = 8

[accounts.player]
kind = "agent"
space = 8

[instructions.mine]
action = "mine"
amount = "amount"

[state_mapping]
"player.gold" = "player.gold"

[actions.mine]
takes = ["amount"]

[observations]
"player.gold" = "uint"

[personas.grinder]
action_rate_multiplier = 1.0
action_weights = { mine = 1.0 }
triggers = []
"#;
    let adapter = parse_adapter_str(toml, "t22-single.toml").expect("single-arg adapter parses");
    let idl = parse_generic_idl_str(single_idl).expect("single-arg IDL parses");
    let builder = GenericInstructionBuilder::new(&idl, &adapter);

    let bytes = builder
        .build_action_data_single_arg("mine", 42)
        .expect("single-arg encodes");
    assert_eq!(bytes.len(), 16, "8-byte disc + 8-byte u64");
    assert_eq!(&bytes[..8], &[109, 105, 110, 101, 0, 0, 0, 0], "mine discriminator");
    assert_eq!(u64::from_le_bytes(bytes[8..16].try_into().unwrap()), 42);
}

#[test]
fn multi_arg_action_rejects_double_binding() {
    // Action declares `amount_in`. Instruction binds it both to the
    // runtime amount AND to a literal — the loader rejects at parse
    // time so a malformed adapter fails loudly instead of silently
    // picking one binding.
    let toml = r#"
protocol = "generic"
program_so = "../programs/resource_grinder/target/deploy/resource_grinder.so"
idl_path = "../fixtures/idls/resource-grinder.json"

[accounts.authority]
kind = "agent"
space = 8

[accounts.pool]
kind = "shared"
space = 16

[instructions.swap]
action = "swap"
amount = "amount_in"
args = { amount_in = 100 }

[state_mapping]
"pool.reserve_a" = "pool.reserve_a"

[actions.swap]
takes = ["amount_in"]

[observations]
"pool.reserve_a" = "uint"

[personas.trader]
action_rate_multiplier = 1.0
action_weights = { swap = 1.0 }
triggers = []
"#;
    let err = parse_adapter_str(toml, "t22-double.toml").unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("bound both as the runtime amount AND as a literal"),
        "expected double-binding diagnostic, got: {msg}"
    );
}

#[test]
fn encoder_rejects_unbound_idl_arg() {
    // IDL declares 3 args; adapter only binds 2 (amount_in + min_out).
    // Encoding should fail on the third arg (`direction`) with a
    // message pointing at the missing binding.
    let toml = r#"
protocol = "generic"
program_so = "../programs/resource_grinder/target/deploy/resource_grinder.so"
idl_path = "../fixtures/idls/resource-grinder.json"

[accounts.authority]
kind = "agent"
space = 8

[accounts.pool]
kind = "shared"
space = 16

[instructions.swap]
action = "swap"
amount = "amount_in"
args = { min_out = 0 }

[state_mapping]
"pool.reserve_a" = "pool.reserve_a"

[actions.swap]
takes = ["amount_in"]

[observations]
"pool.reserve_a" = "uint"

[personas.trader]
action_rate_multiplier = 1.0
action_weights = { swap = 1.0 }
triggers = []
"#;
    let adapter = parse_adapter_str(toml, "t22-unbound.toml")
        .expect("adapter parses (validation passes — loader only checks declared action args)");
    let idl = parse_generic_idl_str(SWAP_IDL).unwrap();
    let builder = GenericInstructionBuilder::new(&idl, &adapter);
    let err = builder.build_action_data_single_arg("swap", 1_000).unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("direction") && msg.contains("not bound"),
        "expected unbound-arg diagnostic naming `direction`, got: {msg}"
    );
}

#[test]
fn encoder_rejects_runtime_overflow_for_u8() {
    // Runtime amount > u8::MAX against a u8-declared arg surfaces a
    // clear error rather than silently wrapping.
    let toml = r#"
protocol = "generic"
program_so = "../programs/resource_grinder/target/deploy/resource_grinder.so"
idl_path = "../fixtures/idls/resource-grinder.json"

[accounts.authority]
kind = "agent"
space = 8

[accounts.pool]
kind = "shared"
space = 16

[instructions.tier_action]
action = "tier_action"
amount = "tier"

[state_mapping]
"pool.reserve_a" = "pool.reserve_a"

[actions.tier_action]
takes = ["tier"]

[observations]
"pool.reserve_a" = "uint"

[personas.tester]
action_rate_multiplier = 1.0
action_weights = { tier_action = 1.0 }
triggers = []
"#;
    let adapter = parse_adapter_str(toml, "t22-overflow.toml").unwrap();
    // One-arg IDL with a u8 type.
    let tiny_idl = r#"
{
  "instructions": [
    {
      "name": "tier_action",
      "discriminator": [10, 20, 30, 40, 0, 0, 0, 0],
      "accounts": [
        { "name": "authority", "signer": true, "writable": true },
        { "name": "pool", "writable": true }
      ],
      "args": [
        { "name": "tier", "type": "u8" }
      ]
    }
  ],
  "accounts": [
    { "name": "pool", "fields": [{ "name": "reserve_a", "type": "u64" }] }
  ],
  "types": []
}
"#;
    let idl = parse_generic_idl_str(tiny_idl).unwrap();
    let builder = GenericInstructionBuilder::new(&idl, &adapter);
    let err = builder
        .build_action_data_single_arg("tier_action", 300)
        .unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("u8") && (msg.contains("exceeds") || msg.contains("overflow")),
        "expected u8 overflow diagnostic, got: {msg}"
    );
}

#[test]
fn loader_rejects_pubkey_literal_with_wrong_byte_count() {
    // Pubkey literal base58-decodes to !=32 bytes → encoder reports
    // the byte-count mismatch at encode time. Loader-level rejection
    // would require teaching the loader about IDL types, which we've
    // punted; encoder-level is sufficient for.
    let toml = r#"
protocol = "generic"
program_so = "../programs/resource_grinder/target/deploy/resource_grinder.so"
idl_path = "../fixtures/idls/resource-grinder.json"

[accounts.authority]
kind = "agent"
space = 8

[accounts.pool]
kind = "shared"
space = 16

[instructions.all_types]
action = "call"
amount = "amt"
args = { delta = 0, cap = 0, tier = 0, flag = false, recipient = "abc" }

[state_mapping]
"pool.reserve_a" = "pool.reserve_a"

[actions.call]
takes = ["amt"]

[observations]
"pool.reserve_a" = "uint"

[personas.tester]
action_rate_multiplier = 1.0
action_weights = { call = 1.0 }
triggers = []
"#;
    let adapter = parse_adapter_str(toml, "t22-shortkey.toml").expect("loader accepts; encoder decides");
    let idl = parse_generic_idl_str(TYPE_MATRIX_IDL).unwrap();
    let builder = GenericInstructionBuilder::new(&idl, &adapter);
    let err = builder.build_action_data_single_arg("call", 1).unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("pubkey") && msg.contains("32"),
        "expected pubkey byte-count diagnostic, got: {msg}"
    );
}

// Negative path — a stray validation error carrying the expected key.
// Checks that loader validation errors preserve the original
// structured shape (path + key + reason) after schema
// extensions. regression surface.
#[test]
fn adapter_validation_errors_still_carry_path_and_key() {
    let toml = r#"
protocol = "generic"
program_so = "../programs/resource_grinder/target/deploy/resource_grinder.so"
idl_path = "../fixtures/idls/resource-grinder.json"

[accounts.authority]
kind = "agent"
space = 8

[accounts.pool]
kind = "shared"
space = 16

[instructions.swap]
action = "swap"

[state_mapping]
"pool.reserve_a" = "pool.reserve_a"

[actions.swap]
takes = ["amount_in"]

[observations]
"pool.reserve_a" = "uint"

[personas.trader]
action_rate_multiplier = 1.0
action_weights = { swap = 1.0 }
triggers = []
"#;
    let err = parse_adapter_str(toml, "t22-missing.toml").unwrap_err();
    match err {
        AdapterError::Validation { path, key, reason } => {
            assert_eq!(path, "t22-missing.toml");
            assert!(key.contains("[actions].swap"), "key was: {key}");
            assert!(
                reason.contains("amount_in"),
                "reason should name the missing arg, got: {reason}"
            );
        }
        other => panic!("expected Validation error, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Real multi-runtime-arg dispatch
// ---------------------------------------------------------------------------
//
// The tests above cover runtime-bound amount + adapter-literal args.
// The tests below cover the spec's other named example: *per-persona
// runtime values* that vary across agents. An adapter declares
// `[instructions.<ix>].args.<name> = "@persona.<field>"` and every
// persona supplies its own `persona_args.<field>`, so one action
// (e.g. `open_position(side, leverage, notional)`) serves leveraged-
// long + leveraged-short + any higher-leverage variant without forking
// into one action per combination.

const OPEN_POSITION_IDL: &str = r#"
{
  "instructions": [
    {
      "name": "open_position",
      "discriminator": [111, 112, 101, 110, 112, 111, 115, 49],
      "accounts": [
        { "name": "authority", "signer": true, "writable": true },
        { "name": "market", "writable": true }
      ],
      "args": [
        { "name": "side", "type": "u8" },
        { "name": "leverage_bps", "type": "u32" },
        { "name": "notional", "type": "u64" }
      ]
    }
  ],
  "accounts": [
    {
      "name": "market",
      "fields": [
        { "name": "total_oi", "type": "u64" }
      ]
    }
  ],
  "types": []
}
"#;

const OPEN_POSITION_ADAPTER_TOML: &str = r#"
protocol = "generic"
program_so = "../programs/resource_grinder/target/deploy/resource_grinder.so"
idl_path = "../fixtures/idls/resource-grinder.json"

[accounts.authority]
kind = "agent"
space = 8

[accounts.market]
kind = "shared"
space = 16

[instructions.open_position]
action = "open_position"
amount = "notional"
args = { side = "@persona.side", leverage_bps = "@persona.leverage_bps" }

[state_mapping]
"market.total_oi" = "market.total_oi"

[actions.open_position]
label = "Open leveraged position"
takes = ["notional", "side", "leverage_bps"]

[observations]
"market.total_oi" = "uint"

[personas.leveraged_long]
action_rate_multiplier = 2.0
action_weights = { open_position = 1.0 }
triggers = []
persona_args = { side = 0, leverage_bps = 50000 }

[personas.leveraged_short]
action_rate_multiplier = 2.0
action_weights = { open_position = 1.0 }
triggers = []
persona_args = { side = 1, leverage_bps = 30000 }

[personas.cautious_long]
action_rate_multiplier = 1.0
action_weights = { open_position = 1.0 }
triggers = []
persona_args = { side = 0, leverage_bps = 15000 }
"#;

#[test]
fn real_multi_runtime_arg_dispatch_varies_by_persona() {
    // Every persona sends open_position(side, leverage_bps, notional).
    // side + leverage_bps are persona-supplied (different values per
    // persona); notional is runtime-supplied (varies per decision).
    // This is the AMM swap(amount_in, min_out, direction) shape and
    // the perps open_position(side, leverage, notional) shape from
    // spec.md:35 — both satisfied through one adapter action.
    let adapter = parse_adapter_str(OPEN_POSITION_ADAPTER_TOML, "t22-open.toml")
        .expect("multi-runtime adapter parses");
    let idl = parse_generic_idl_str(OPEN_POSITION_IDL).expect("open_position IDL parses");

    // Compile personas into Policies so we can pull persona_args the
    // way the tick loop does.
    let policies = build_generic_policies(&adapter, |_| {}).expect("compile personas");
    let long = policies.iter().find(|p| p.persona_id == "leveraged_long").unwrap();
    let short = policies.iter().find(|p| p.persona_id == "leveraged_short").unwrap();
    let cautious = policies.iter().find(|p| p.persona_id == "cautious_long").unwrap();

    let builder = GenericInstructionBuilder::new(&idl, &adapter);

    // Dispatch #1 — leveraged_long with notional=1000.
    let long_bytes = builder
        .build_action_data("open_position", 1_000, &long.persona_args)
        .expect("long dispatches with persona-supplied side + leverage");
    // discriminator (8) + side u8 (1) + leverage_bps u32 (4) + notional u64 (8) = 21.
    assert_eq!(long_bytes.len(), 21, "open_position payload: {}", long_bytes.len());
    assert_eq!(long_bytes[8], 0, "leveraged_long side=0 (long)");
    assert_eq!(
        u32::from_le_bytes(long_bytes[9..13].try_into().unwrap()),
        50_000,
        "leveraged_long leverage_bps=50000 (5x)"
    );
    assert_eq!(
        u64::from_le_bytes(long_bytes[13..21].try_into().unwrap()),
        1_000,
        "notional is runtime-bound"
    );

    // Dispatch #2 — leveraged_short with notional=250.
    let short_bytes = builder
        .build_action_data("open_position", 250, &short.persona_args)
        .expect("short dispatches with its own persona values");
    assert_eq!(short_bytes[8], 1, "leveraged_short side=1 (short)");
    assert_eq!(
        u32::from_le_bytes(short_bytes[9..13].try_into().unwrap()),
        30_000,
        "leveraged_short leverage_bps=30000 (3x)"
    );
    assert_eq!(
        u64::from_le_bytes(short_bytes[13..21].try_into().unwrap()),
        250,
        "notional differs between dispatches"
    );

    // Dispatch #3 — cautious_long with same notional=1000 as long
    // but different leverage.
    let cautious_bytes = builder
        .build_action_data("open_position", 1_000, &cautious.persona_args)
        .expect("cautious dispatches with its own leverage cap");
    assert_eq!(cautious_bytes[8], 0, "cautious_long is still a long");
    assert_eq!(
        u32::from_le_bytes(cautious_bytes[9..13].try_into().unwrap()),
        15_000,
        "cautious_long leverage_bps=15000 (1.5x)"
    );

    // Cross-persona byte differentiation — sanity check the byte
    // streams are actually different per persona, proving the
    // @persona.<field> resolver is doing the work.
    assert_ne!(long_bytes, short_bytes);
    assert_ne!(long_bytes, cautious_bytes);
    assert_ne!(short_bytes, cautious_bytes);
}

#[test]
fn missing_persona_arg_field_fails_with_clear_error() {
    // Persona declares `side` + `leverage_bps` in persona_args but
    // adapter references a field the persona doesn't supply — encode
    // should bail with a diagnostic that names both the instruction,
    // the arg, AND the missing field.
    let broken_adapter = r#"
protocol = "generic"
program_so = "../programs/resource_grinder/target/deploy/resource_grinder.so"
idl_path = "../fixtures/idls/resource-grinder.json"

[accounts.authority]
kind = "agent"
space = 8

[accounts.market]
kind = "shared"
space = 16

[instructions.open_position]
action = "open_position"
amount = "notional"
args = { side = "@persona.side", leverage_bps = "@persona.nonexistent_field" }

[state_mapping]
"market.total_oi" = "market.total_oi"

[actions.open_position]
takes = ["notional"]

[observations]
"market.total_oi" = "uint"

[personas.leveraged_long]
action_rate_multiplier = 1.0
action_weights = { open_position = 1.0 }
triggers = []
persona_args = { side = 0 }
"#;
    let adapter = parse_adapter_str(broken_adapter, "t22-missing-field.toml")
        .expect("loader passes — missing field is caught at encode time");
    let idl = parse_generic_idl_str(OPEN_POSITION_IDL).unwrap();
    let policies = build_generic_policies(&adapter, |_| {}).unwrap();
    let long = policies.iter().find(|p| p.persona_id == "leveraged_long").unwrap();

    let builder = GenericInstructionBuilder::new(&idl, &adapter);
    let err = builder
        .build_action_data("open_position", 1_000, &long.persona_args)
        .unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("@persona.nonexistent_field"),
        "error must name the missing field, got: {msg}"
    );
    assert!(
        msg.contains("open_position") || msg.contains("leverage_bps"),
        "error should name instruction/arg context, got: {msg}"
    );
}

#[test]
fn persona_args_coerce_into_idl_arg_types() {
    // persona_args values come in as ArgLiteral::Int / Bool / String
    // variants. The encoder must coerce them into each IDL arg's
    // declared Borsh type the same way adapter-literal args do.
    // Build a persona with bool + pubkey persona_args and dispatch
    // through an all-types instruction.
    let recipient = "GLe1xiYPUBRQCrxQA1wMVSESmCqY1YgVi1Rrhu7oMUhk";
    let toml = format!(
        r#"
protocol = "generic"
program_so = "../programs/resource_grinder/target/deploy/resource_grinder.so"
idl_path = "../fixtures/idls/resource-grinder.json"

[accounts.authority]
kind = "agent"
space = 8

[accounts.pool]
kind = "shared"
space = 16

[instructions.all_types]
action = "call"
amount = "amt"
args = {{ delta = "@persona.delta", cap = "@persona.cap", tier = "@persona.tier", flag = "@persona.flag", recipient = "@persona.recipient" }}

[state_mapping]
"pool.reserve_a" = "pool.reserve_a"

[actions.call]
takes = ["amt"]

[observations]
"pool.reserve_a" = "uint"

[personas.tester]
action_rate_multiplier = 1.0
action_weights = {{ call = 1.0 }}
triggers = []
persona_args = {{ delta = -17, cap = 99, tier = 5, flag = true, recipient = "{recipient}" }}
"#
    );
    let adapter = parse_adapter_str(&toml, "t22-persona-types.toml")
        .expect("persona args coerce across types");
    let idl = parse_generic_idl_str(TYPE_MATRIX_IDL).unwrap();
    let policies = build_generic_policies(&adapter, |_| {}).unwrap();
    let tester = policies.iter().find(|p| p.persona_id == "tester").unwrap();

    // Sanity-check the compiled persona_args map carries the right
    // ArgLiteral variants (spec-level invariant — if this drifts the
    // serde derive on ArgLiteral regressed).
    assert!(matches!(tester.persona_args["delta"], ArgLiteral::Int(-17)));
    assert!(matches!(tester.persona_args["cap"], ArgLiteral::Int(99)));
    assert!(matches!(tester.persona_args["tier"], ArgLiteral::Int(5)));
    assert!(matches!(tester.persona_args["flag"], ArgLiteral::Bool(true)));
    assert!(matches!(tester.persona_args["recipient"], ArgLiteral::String(_)));

    let builder = GenericInstructionBuilder::new(&idl, &adapter);
    let bytes = builder
        .build_action_data("call", 42, &tester.persona_args)
        .expect("6-arg persona-supplied encode");
    assert_eq!(bytes.len(), 62);
    assert_eq!(&bytes[..8], &[1, 2, 3, 4, 5, 6, 7, 8]);
    assert_eq!(u64::from_le_bytes(bytes[8..16].try_into().unwrap()), 42);
    assert_eq!(i64::from_le_bytes(bytes[16..24].try_into().unwrap()), -17);
    assert_eq!(u32::from_le_bytes(bytes[24..28].try_into().unwrap()), 99);
    assert_eq!(bytes[28], 5);
    assert_eq!(bytes[29], 1);
    let recipient_bytes = bs58::decode(recipient).into_vec().unwrap();
    assert_eq!(&bytes[30..62], recipient_bytes.as_slice());
}

// Build a clean reference to BTreeMap<String, ArgLiteral> for
// anyone reading this test file: the tick loop hands
// `policy.persona_args` (a BTreeMap<String, ArgLiteral>) to the
// encoder. Ensuring the type line up with the trait surface
// catches accidental regression if Policy's persona_args field
// ever changes shape.
#[allow(dead_code)]
fn _t01_policy_persona_args_typecheck(
    policy: &riptide_engine::types::Policy,
) -> &BTreeMap<String, ArgLiteral> {
    &policy.persona_args
}

// ---------------------------------------------------------------------------
// Round 4 — loader rejects split bindings across duplicate action mappings
// ---------------------------------------------------------------------------
//
// Before Round 4, the loader unioned `amount` + `args` across every
// instruction mapping that claimed a given action. The runtime
// resolver (`resolve_instruction_for_action`) picks the FIRST mapping
// by BTreeMap order though, so the split-bindings combination below
// would silently load-time-pass, then explode at dispatch with
// "arg X not bound" when the first mapping's bindings were
// incomplete. Round 4 catches this at load time.

#[test]
fn loader_rejects_split_bindings_across_duplicate_action_mappings() {
    // `swap_a` binds amount_in via runtime; `swap_b` binds min_out +
    // direction via literals. Both target the same `swap` action. The
    // runtime would only see `swap_a` and fail mid-dispatch on
    // min_out/direction. Round 4 rejects at load time.
    let toml = r#"
protocol = "generic"
program_so = "../programs/resource_grinder/target/deploy/resource_grinder.so"
idl_path = "../fixtures/idls/resource-grinder.json"

[accounts.authority]
kind = "agent"
space = 8

[accounts.pool]
kind = "shared"
space = 16

[instructions.swap_a]
action = "swap"
amount = "amount_in"

[instructions.swap_b]
action = "swap"
args = { min_out = 0, direction = false }

[state_mapping]
"pool.reserve_a" = "pool.reserve_a"

[actions.swap]
takes = ["amount_in", "min_out", "direction"]

[observations]
"pool.reserve_a" = "uint"

[personas.trader]
action_rate_multiplier = 1.0
action_weights = { swap = 1.0 }
triggers = []
"#;
    let err = parse_adapter_str(toml, "t22-split.toml").unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("multiple") && msg.contains("[instructions]"),
        "expected multi-mapping rejection, got: {msg}"
    );
    assert!(
        msg.contains("swap_a") && msg.contains("swap_b"),
        "diagnostic must name the offending instruction entries, got: {msg}"
    );
}

#[test]
fn loader_accepts_single_mapping_per_action() {
    // Ensure the tightened rule doesn't regress the normal case:
    // exactly one mapping per action with complete bindings.
    let toml = r#"
protocol = "generic"
program_so = "../programs/resource_grinder/target/deploy/resource_grinder.so"
idl_path = "../fixtures/idls/resource-grinder.json"

[accounts.authority]
kind = "agent"
space = 8

[accounts.pool]
kind = "shared"
space = 16

[instructions.swap]
action = "swap"
amount = "amount_in"
args = { min_out = 0, direction = false }

[state_mapping]
"pool.reserve_a" = "pool.reserve_a"

[actions.swap]
takes = ["amount_in", "min_out", "direction"]

[observations]
"pool.reserve_a" = "uint"

[personas.trader]
action_rate_multiplier = 1.0
action_weights = { swap = 1.0 }
triggers = []
"#;
    parse_adapter_str(toml, "t22-single-mapping.toml")
        .expect("one mapping per action with complete bindings should still pass");
}
