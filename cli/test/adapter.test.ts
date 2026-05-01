// Adapter schema round-trip tests.
//
// Contract: the CLI Zod schema and the engine serde schema parse the
// same adapter TOML into structurally equivalent objects. If either
// validator rejects `fixtures/adapters/lending.toml`, this test
// fails — so schema drift is caught before a demo run.
//
// We don't invoke the engine binary here (that path is exercised by
// the engine's own unit tests + the demo run). The test asserts the
// Zod side loads the shipped fixture, produces a known-shaped object,
// and rejects the same validation failures the serde side rejects.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import TOML from "toml";

import {
  AdapterSchema,
  LENDING_ACTIONS,
  LENDING_OBSERVATIONS,
  SEMANTIC_CLASS_RE_SOURCE,
  resolveAdapterRuntime,
  validateAdapter,
} from "../src/schemas/adapter.js";

async function loadFixture(): Promise<unknown> {
  const fixturePath = path.resolve(
    process.cwd(),
    "..",
    "fixtures",
    "adapters",
    "lending.toml"
  );
  const raw = await readFile(fixturePath, "utf8");
  return TOML.parse(raw);
}

test("AdapterSchema accepts the shipped lending fixture", async () => {
  const raw = await loadFixture();
  const adapter = validateAdapter(raw, "fixtures/adapters/lending.toml");

  assert.equal(adapter.protocol, "lending");
  assert.equal(Object.keys(adapter.instructions).length, 5);
  for (const action of LENDING_ACTIONS) {
    const hasAction = Object.values(adapter.instructions).some(
      (mapping) => mapping.action === action
    );
    assert.equal(
      hasAction,
      true,
      `fixture should map every canonical lending action (missing: ${action})`
    );
  }
  assert.equal(
    Object.values(adapter.state_mapping).some((v) => v === "tvl"),
    true,
    "fixture should include a tvl observation"
  );
});

test("AdapterSchema produces the same shape the serde side expects", async () => {
  // Structural keys the serde Adapter struct expects. If the Rust side
  // renames a field, the deserialization of a Zod-validated object back
  // through Rust will fail — and vice versa. Keeping this list
  // hand-maintained is cheap and catches drift early.
  const raw = await loadFixture();
  const adapter = validateAdapter(raw, "fixture");

  const topLevel = Object.keys(adapter).sort();
  assert.deepEqual(
    topLevel,
    [
      "accounts",
      "actions",
      "errors",
      "instructions",
      "invariants",
      "lineage",
      "observations",
      "oracles",
      "personas",
      "protocol",
      "scheduled_actions",
      "semantics",
      "state_mapping",
    ],
    "top-level adapter keys should match engine/src/adapter/schema.rs::Adapter"
  );

  for (const mapping of Object.values(adapter.instructions)) {
    const keys = Object.keys(mapping).sort();
    // `amount` and `args` are optional; only `action` is required.
    assert.ok(keys.includes("action"));
    const illegal = keys.filter(
      (k) => k !== "action" && k !== "amount" && k !== "args"
    );
    assert.deepEqual(
      illegal,
      [],
      "InstructionMapping should only carry action/amount/args fields"
    );
  }
});

test("AdapterSchema accepts a generic adapter shape", () => {
  const raw = {
    protocol: "generic",
    program_so: "programs/resource_grinder/target/deploy/resource_grinder.so",
    idl_path: "fixtures/idls/resource-grinder.json",
    accounts: {
      player: { kind: "agent", space: 48 },
      marketplace: { kind: "shared", space: 512 },
    },
    instructions: {
      mine: { action: "mine", amount: "amount" },
      craft: { action: "craft" },
      list_for_sale: { action: "list_for_sale" },
    },
    state_mapping: {
      "player.gold": "player.gold",
      "player.wood": "player.wood",
      "marketplace.listings": "marketplace.listings",
    },
    actions: {
      mine: { takes: ["amount"] },
      craft: { takes: [] },
      list_for_sale: { takes: [] },
    },
    observations: {
      "player.gold": "uint",
      "player.wood": "uint",
      "marketplace.listings": "map",
    },
    personas: {
      grinder: {
        action_rate_multiplier: 1.5,
        action_weights: { mine: 1, craft: 0.2 },
        triggers: [{ if: "player.wood < 10", then: "mine", weight_boost: 2 }],
      },
    },
  };

  const adapter = validateAdapter(raw, "generic.toml");
  assert.equal(adapter.protocol, "generic");
  assert.equal(adapter.program_so, raw.program_so);
  assert.equal(adapter.idl_path, raw.idl_path);
  assert.equal(adapter.accounts.player.kind, "agent");
});

function minimalLendingAdapterWithSemantics(overrides: Record<string, unknown> = {}): unknown {
  return {
    protocol: "lending",
    instructions: {
      deposit: { action: "deposit", amount: "amount" },
      borrow: { action: "borrow", amount: "amount" },
      repay: { action: "repay", amount: "amount" },
      withdraw: { action: "withdraw", amount: "amount" },
      liquidate: { action: "liquidate", amount: "repay_amount" },
    },
    state_mapping: {
      "pool.total_deposits": "tvl",
      "pool.total_borrows": "debt",
      "pool.bad_debt": "bad_debt",
      "position.collateral": "collateral",
      "position.debt": "debt",
      "position.liquidated": "liquidated",
    },
    semantics: {
      class: "lending.v1",
      roles: {
        position: {
          source: "instruction.deposit",
          fields: { collateral_amount: "u128", debt_amount: "u128" },
        },
        reserve: {
          source: "account.reserve",
          fields: { collateral_price: "u128", max_ltv_bps: "u64" },
        },
        oracle: {
          source: "account.oracle",
          fields: { price: "u128" },
        },
        liquidation_config: {
          source: "account.reserve",
          fields: { liquidation_threshold_bps: "u64" },
        },
      },
      derived: {
        collateral_value: "position.collateral_amount * reserve.collateral_price / 10000",
        debt_value: "position.debt_amount",
        max_borrow_value: "collateral_value * reserve.max_ltv_bps / 10000",
        health_factor: "collateral_value * 10000 / debt_value",
      },
      invariants: [
        {
          name: "bad_debt_bound",
          expr: "debt_value <= collateral_value",
          severity: "warn",
        },
        {
          name: "ltv_below_max",
          expr: "debt_value <= max_borrow_value",
        },
      ],
      ...overrides,
    },
  };
}

function minimalGenericAdapterWithLendingSemantics(): unknown {
  const lending = minimalLendingAdapterWithSemantics() as any;
  return {
    protocol: "generic",
    program_so: "target/deploy/lending.so",
    idl_path: "target/idl/lending.json",
    accounts: {
      position: { kind: "agent", space: 128 },
      reserve: { kind: "shared", space: 256 },
      oracle: { kind: "shared", space: 128 },
    },
    instructions: {
      deposit: { action: "deposit", amount: "amount" },
    },
    state_mapping: {
      "position.collateral_amount": "position.collateral_amount",
      "position.debt_amount": "position.debt_amount",
      "reserve.collateral_price": "reserve.collateral_price",
      "reserve.max_ltv_bps": "reserve.max_ltv_bps",
      "oracle.price": "oracle.price",
    },
    actions: {
      deposit: { takes: ["amount"] },
    },
    observations: {
      "position.collateral_amount": "uint",
      "position.debt_amount": "uint",
      "reserve.collateral_price": "uint",
      "reserve.max_ltv_bps": "uint",
      "oracle.price": "uint",
    },
    personas: {
      depositor: {
        action_rate_multiplier: 1,
        action_weights: { deposit: 1 },
      },
    },
    semantics: lending.semantics,
  };
}

test("AdapterSchema accepts semantics block and defaults invariant severity", () => {
  const adapter = validateAdapter(minimalLendingAdapterWithSemantics(), "semantics.toml");

  assert.equal(adapter.semantics?.class, "lending.v1");
  assert.equal(adapter.semantics?.invariants[0]?.severity, "warn");
  assert.equal(adapter.semantics?.invariants[1]?.severity, "error");
});

test("AdapterSchema accepts generic SBF/IDL runtime with lending.v1 economic semantics", () => {
  const adapter = validateAdapter(
    minimalGenericAdapterWithLendingSemantics(),
    "generic-lending.toml"
  );

  assert.equal(adapter.protocol, "generic");
  assert.equal(adapter.program_so, "target/deploy/lending.so");
  assert.equal(adapter.idl_path, "target/idl/lending.json");
  assert.equal(adapter.semantics?.class, "lending.v1");
});

test("AdapterSchema infers generic runtime from program_so and idl_path when protocol is omitted", () => {
  const raw = minimalGenericAdapterWithLendingSemantics() as any;
  delete raw.protocol;

  const adapter = validateAdapter(raw, "generic-lending.toml");

  assert.equal(adapter.protocol, undefined);
  assert.equal(resolveAdapterRuntime(adapter), "generic");
  assert.equal(adapter.semantics?.class, "lending.v1");
});

test("AdapterSchema lets program artifacts override the protocol backcompat hint", () => {
  const raw = minimalGenericAdapterWithLendingSemantics() as any;
  raw.protocol = "lending";

  const adapter = validateAdapter(raw, "generic-lending.toml");

  assert.equal(adapter.protocol, "lending");
  assert.equal(resolveAdapterRuntime(adapter), "generic");
});

test("AdapterSchema rejects adapters with neither runtime artifacts nor protocol hint", () => {
  const raw = minimalLendingAdapterWithSemantics() as any;
  delete raw.protocol;

  assert.throws(
    () => validateAdapter(raw, "missing-runtime.toml"),
    /missing runtime selection/
  );
});

test("AdapterSchema semantics class regex mirrors Rust", () => {
  assert.equal(SEMANTIC_CLASS_RE_SOURCE, "^[a-z][a-z0-9-]*\\.v[0-9]+$");
});

test("AdapterSchema rejects malformed semantics shapes", () => {
  assert.throws(
    () => validateAdapter(minimalLendingAdapterWithSemantics({ class: undefined }), "semantics.toml"),
    /MissingSemanticClass/
  );
  assert.throws(
    () => validateAdapter(minimalLendingAdapterWithSemantics({ class: "Lending.v1" }), "semantics.toml"),
    /malformed semantic class/
  );
  assert.throws(
    () => validateAdapter(minimalLendingAdapterWithSemantics({ class: "amm.v1" }), "semantics.toml"),
    /UnknownSemanticClass/
  );

  const missingRole = minimalLendingAdapterWithSemantics({
    roles: {
      position: { source: "instruction.deposit", fields: { collateral_amount: "u128" } },
      reserve: { source: "account.reserve", fields: { collateral_price: "u128" } },
      oracle: { source: "account.oracle", fields: { price: "u128" } },
    },
  });
  assert.throws(() => validateAdapter(missingRole, "semantics.toml"), /liquidation_config/);

  const unknownSource = minimalLendingAdapterWithSemantics({
    roles: {
      position: { source: "wallet.position", fields: { collateral_amount: "u128" } },
      reserve: { source: "account.reserve", fields: { collateral_price: "u128" } },
      oracle: { source: "account.oracle", fields: { price: "u128" } },
      liquidation_config: { source: "account.reserve", fields: { liquidation_threshold_bps: "u64" } },
    },
  });
  assert.throws(() => validateAdapter(unknownSource, "semantics.toml"), /unknown source binding type/);

  const duplicateInvariant = minimalLendingAdapterWithSemantics({
    invariants: [
      { name: "bad_debt_bound", expr: "debt_value <= collateral_value" },
      { name: "bad_debt_bound", expr: "debt_value <= max_borrow_value" },
    ],
  });
  assert.throws(() => validateAdapter(duplicateInvariant, "semantics.toml"), /duplicate semantic name/);
});

test("AdapterSchema semantic diagnostics escape terminal controls", () => {
  assertSemanticDiagnosticEscaped(
    "semantic class",
    minimalLendingAdapterWithSemantics({ class: "lend\u001bing.v1" })
  );

  const badSource = minimalLendingAdapterWithSemantics() as any;
  badSource.semantics.roles.position.source = "\u001b[2Jwallet.position";
  assertSemanticDiagnosticEscaped("semantic source", badSource);

  const badRole = minimalLendingAdapterWithSemantics() as any;
  badRole.semantics.roles["bad\u001brole"] = {
    source: "account.reserve",
    fields: { amount: "u128" },
  };
  assertSemanticDiagnosticEscaped("semantic role name", badRole);

  const badField = minimalLendingAdapterWithSemantics() as any;
  badField.semantics.roles.position.fields["bad\u001bfield"] = "u128";
  assertSemanticDiagnosticEscaped("semantic field name", badField);

  const badDerived = minimalLendingAdapterWithSemantics() as any;
  badDerived.semantics.derived["bad\u001bderived"] = "1";
  assertSemanticDiagnosticEscaped("semantic derived name", badDerived);

  const badInvariant = minimalLendingAdapterWithSemantics() as any;
  badInvariant.semantics.invariants[0].name = "bad\u001binvariant";
  assertSemanticDiagnosticEscaped("semantic invariant name", badInvariant);
});

function assertSemanticDiagnosticEscaped(label: string, raw: unknown): void {
  assert.throws(
    () => validateAdapter(raw, "semantics.toml"),
    (err: unknown) => {
      assert.ok(err instanceof Error, `${label}: expected Error`);
      assert.equal(
        containsTerminalControl(err.message),
        false,
        `${label}: diagnostic preserved a raw terminal control: ${JSON.stringify(err.message)}`
      );
      assert.match(
        err.message,
        /\\u\{1b\}/,
        `${label}: diagnostic should escape the injected ESC byte`
      );
      return true;
    }
  );
}

function containsTerminalControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 0x20) return true;
    if (code === 0x7f) return true;
    if (code >= 0x80 && code < 0xa0) return true;
  }
  return false;
}

test("AdapterSchema rejects unknown lending actions with an actionable error", () => {
  const raw = {
    protocol: "lending",
    instructions: { foo: { action: "bogus" } },
    state_mapping: { "pool.total_deposits": "tvl" },
  };
  assert.throws(
    () => validateAdapter(raw, "bad.toml"),
    (err: Error) => {
      assert.ok(err.message.includes("bad.toml"), `missing path: ${err.message}`);
      assert.ok(
        err.message.includes("[instructions].foo.action"),
        `missing key: ${err.message}`
      );
      assert.ok(err.message.includes("bogus"), `missing value: ${err.message}`);
      return true;
    }
  );
});

test("AdapterSchema rejects malformed state_mapping keys", () => {
  const raw = {
    protocol: "lending",
    instructions: { deposit: { action: "deposit", amount: "amount" } },
    state_mapping: { poolwithoutdot: "tvl" },
  };
  assert.throws(
    () => validateAdapter(raw, "bad.toml"),
    (err: Error) => {
      assert.ok(err.message.includes("[state_mapping].poolwithoutdot"));
      assert.ok(err.message.includes("<account>.<field>"));
      return true;
    }
  );
});

test("AdapterSchema rejects unknown observations", () => {
  const raw = {
    protocol: "lending",
    instructions: { deposit: { action: "deposit", amount: "amount" } },
    state_mapping: { "pool.total_deposits": "magic_number" },
  };
  assert.throws(
    () => validateAdapter(raw, "bad.toml"),
    (err: Error) => {
      assert.ok(err.message.includes("[state_mapping].pool.total_deposits"));
      assert.ok(err.message.includes("magic_number"));
      return true;
    }
  );
});

test("AdapterSchema rejects unsupported generic trigger operators", () => {
  const raw = {
    protocol: "generic",
    program_so: "programs/resource_grinder/target/deploy/resource_grinder.so",
    idl_path: "fixtures/idls/resource-grinder.json",
    accounts: {
      player: { kind: "agent", space: 48 },
    },
    instructions: {
      mine: { action: "mine" },
    },
    state_mapping: {
      "player.gold": "player.gold",
    },
    actions: {
      mine: { takes: [] },
    },
    observations: {
      "player.gold": "uint",
    },
    personas: {
      grinder: {
        action_weights: { mine: 1 },
        triggers: [{ if: "player.gold <= 10", then: "mine", weight_boost: 1 }],
      },
    },
  };

  assert.throws(
    () => validateAdapter(raw, "bad-generic.toml"),
    (err: Error) => {
      assert.ok(err.message.includes("triggers[0].if"));
      assert.ok(err.message.includes("unsupported generic trigger operator"));
      return true;
    }
  );
});

test("AdapterSchema LENDING_ACTIONS is identical to the Rust canonical list", () => {
  // This is the contract anchor. If someone adds an action on one side
  // without the other, the fixture check above would fail, but this
  // gives a clearer failure message for a pure label drift.
  const sortedZod = [...LENDING_ACTIONS].sort();
  assert.deepEqual(sortedZod, [
    "borrow",
    "deposit",
    "liquidate",
    "repay",
    "withdraw",
  ]);
});

test("AdapterSchema LENDING_OBSERVATIONS is identical to the Rust canonical list", () => {
  const sortedZod = [...LENDING_OBSERVATIONS].sort();
  assert.deepEqual(sortedZod, [
    "bad_debt",
    "collateral",
    "debt",
    "liquidated",
    "tvl",
  ]);
});

// Mirror the engine-side adapter identifier allow-list. A malicious
// adapter TOML that smuggles a
// control character through an observation/action/persona name must
// be rejected at adapter-load time on both ends, not just at render
// time.

function minimalGenericAdapter(overrides: {
  observationKey?: string;
  actionKey?: string;
  personaLabel?: string;
  stateMappingValue?: string;
} = {}): unknown {
  const observationKey = overrides.observationKey ?? "player.gold";
  const actionKey = overrides.actionKey ?? "mine";
  return {
    protocol: "generic",
    program_so: "out/demo.so",
    idl_path: "out/demo.json",
    accounts: {
      player: { kind: "agent", space: 32 },
    },
    instructions: {
      [actionKey]: { action: actionKey, amount: "amount" },
    },
    state_mapping: {
      "player.gold": overrides.stateMappingValue ?? "player.gold",
    },
    actions: {
      [actionKey]: { takes: ["amount"] },
    },
    observations: {
      [observationKey]: "uint",
    },
    personas: {
      grinder: {
        label: overrides.personaLabel,
        action_weights: { [actionKey]: 1.0 },
        triggers: [],
      },
    },
  };
}

function minimalDecoderAdapter(decoder: unknown, mappingKey = "vault.amount"): unknown {
  return {
    protocol: "generic",
    program_so: "out/demo.so",
    idl_path: "out/demo.json",
    accounts: {
      vault: { kind: "shared", space: 165, decoder },
    },
    instructions: {
      noop: { action: "noop" },
    },
    state_mapping: {
      [mappingKey]: "vault.amount",
    },
    actions: {
      noop: { takes: [] },
    },
    observations: {
      "vault.amount": "uint",
    },
    personas: {
      passive: {
        action_rate_multiplier: 0,
        action_weights: { noop: 0 },
        triggers: [],
      },
    },
  };
}

test("validateAdapter accepts account decoder presets", () => {
  const adapter = validateAdapter(minimalDecoderAdapter("spl_token_account"), "decoder.toml");
  assert.equal(adapter.accounts.vault.decoder, "spl_token_account");
});

test("validateAdapter accepts raw layout account decoders", () => {
  const adapter = validateAdapter(
    minimalDecoderAdapter({
      kind: "layout",
      fields: {
        amount: { type: "u64", offset: 64 },
      },
    }),
    "decoder.toml"
  );
  assert.deepEqual(adapter.accounts.vault.decoder, {
    kind: "layout",
    fields: {
      amount: { type: "u64", offset: 64 },
    },
  });
});

test("validateAdapter rejects unknown decoder presets", () => {
  assert.throws(
    () => validateAdapter(minimalDecoderAdapter("orca_pool"), "decoder.toml"),
    /unknown account decoder preset/
  );
});

test("validateAdapter rejects invalid decoder field types", () => {
  assert.throws(
    () =>
      validateAdapter(
        minimalDecoderAdapter({
          kind: "layout",
          fields: { amount: { type: "u32", offset: 64 } },
        }),
        "decoder.toml"
      ),
    /unknown layout field type/
  );
});

test("validateAdapter rejects decoder fields past account space", () => {
  assert.throws(
    () =>
      validateAdapter(
        minimalDecoderAdapter({
          kind: "layout",
          fields: { amount: { type: "u64", offset: 164 } },
        }),
        "decoder.toml"
      ),
    /exceeds declared account space/
  );
});

test("validateAdapter rejects mappings to undeclared decoder fields", () => {
  assert.throws(
    () =>
      validateAdapter(
        minimalDecoderAdapter("spl_token_account", "vault.balance"),
        "decoder.toml"
      ),
    /decoder field `balance`/
  );
});

test("validateAdapter rejects observation key with ANSI escape", () => {
  const raw = minimalGenericAdapter({ observationKey: "line\u001bbreak" });
  assert.throws(
    () => validateAdapter(raw, "evil.toml"),
    /adapter identifier.*ANSI/i
  );
});

test("validateAdapter rejects action name with embedded newline", () => {
  const raw = minimalGenericAdapter({ actionKey: "mine\nforged" });
  assert.throws(
    () => validateAdapter(raw, "evil.toml"),
    /adapter identifier/i
  );
});

test("validateAdapter rejects persona label containing a control character", () => {
  const raw = minimalGenericAdapter({ personaLabel: "Grinder\u001b[31m" });
  assert.throws(
    () => validateAdapter(raw, "evil.toml"),
    /adapter label.*control characters/i
  );
});

test("validateAdapter rejects state_mapping value with bell control byte", () => {
  const raw = minimalGenericAdapter({ stateMappingValue: "player.\u0007bell" });
  assert.throws(
    () => validateAdapter(raw, "evil.toml"),
    /adapter identifier/i
  );
});

test("validateAdapter accepts the safe minimal adapter", () => {
  const raw = minimalGenericAdapter();
  const adapter = validateAdapter(raw, "safe.toml");
  assert.equal(adapter.protocol, "generic");
});

test("validateLineage rejects typoed keys instead of silently dropping them", () => {
  // A typo like `unsupported_field` (singular, not plural) must fail
  // validation, not silently render as "(none recorded)" in
  // `riptide lineage`. `.strict()` on the lineage schema — mirroring
  // `#[serde(deny_unknown_fields)]` on the Rust side — enforces this.
  const raw = {
    protocol: "lending",
    instructions: {
      deposit: { action: "deposit", amount: "amount" },
    },
    state_mapping: { "pool.total_deposits": "tvl" },
    lineage: {
      unsupported_field: ["typoed singular, not plural"],
    },
  };
  assert.throws(
    () => validateAdapter(raw, "lineage-typo.toml"),
    /unsupported_field/,
    "CLI must reject typoed lineage keys, same as the engine"
  );
});

test("validateLineage caps lineage text at UTF-8 byte length (not JS char length)", () => {
  // Engine uses Rust `str.len()` (UTF-8 bytes). CLI previously used
  // `String.length` (UTF-16 code units) which diverges for non-ASCII.
  // 'é' = 2 UTF-8 bytes but JS length 1; 513 of them = 1026 UTF-8
  // bytes (over the 1024 cap) but JS length 513 (under). An entry
  // that passes JS-length would then fail when the engine loaded
  // the same TOML — breaks the parity promise. This test pins the
  // byte-length comparison so that regression can't come back.
  const raw = {
    protocol: "lending",
    instructions: {
      deposit: { action: "deposit", amount: "amount" },
    },
    state_mapping: { "pool.total_deposits": "tvl" },
    lineage: {
      inferred_assumptions: ["é".repeat(513)], // 1026 UTF-8 bytes
    },
  };
  assert.throws(
    () => validateAdapter(raw, "utf8-parity.toml"),
    /\[lineage\]\.inferred_assumptions\[0\].*lineage text must be non-empty, at most 1024 bytes/,
    "CLI must reject lineage text over 1024 UTF-8 bytes, same as the engine"
  );

  // Byte-length parity also accepts what the engine accepts:
  // 512 'é' = 1024 UTF-8 bytes (at the cap, not over).
  const accepted = {
    protocol: "lending",
    instructions: {
      deposit: { action: "deposit", amount: "amount" },
    },
    state_mapping: { "pool.total_deposits": "tvl" },
    lineage: {
      inferred_assumptions: ["é".repeat(512)],
    },
  };
  const adapter = validateAdapter(accepted, "utf8-parity-accept.toml");
  assert.equal(adapter.lineage?.inferred_assumptions.length, 1);
});
