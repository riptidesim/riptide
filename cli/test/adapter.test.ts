// Adapter schema round-trip tests.
//
// Contract: the CLI Zod schema and the engine serde schema parse the
// same adapter TOML into structurally equivalent objects. If either
// validator rejects `fixtures/adapters/solend-fork.toml`, this test
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
  validateAdapter,
} from "../src/schemas/adapter.js";

async function loadFixture(): Promise<unknown> {
  const fixturePath = path.resolve(
    process.cwd(),
    "..",
    "fixtures",
    "adapters",
    "solend-fork.toml"
  );
  const raw = await readFile(fixturePath, "utf8");
  return TOML.parse(raw);
}

test("AdapterSchema accepts the shipped solend-fork fixture", async () => {
  const raw = await loadFixture();
  const adapter = validateAdapter(raw, "fixtures/adapters/solend-fork.toml");

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
      "instructions",
      "invariants",
      "observations",
      "oracles",
      "personas",
      "protocol",
      "scheduled_actions",
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
