// Adapter schema round-trip tests (Sprint 3 · T04).
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
      "actions",
      "instructions",
      "observations",
      "personas",
      "protocol",
      "state_mapping",
    ],
    "top-level adapter keys should match engine/src/adapter/schema.rs::Adapter"
  );

  for (const mapping of Object.values(adapter.instructions)) {
    const keys = Object.keys(mapping).sort();
    // `amount` is optional, so we only require `action`
    assert.ok(keys.includes("action"));
    const illegal = keys.filter((k) => k !== "action" && k !== "amount");
    assert.deepEqual(
      illegal,
      [],
      "InstructionMapping should only carry action/amount fields"
    );
  }
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
