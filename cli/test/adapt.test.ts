// `riptide adapt` smoke-test harness tests.
//
// The command is now a smoke-test harness, not a generator. These
// tests exercise:
// - exit 2 when the adapter file is missing
// - exit 2 when the TOML parses but fails Zod validation
// - exit 1 when the smoke runner reports failure (adapter path printed)
// - exit 0 on a clean lending adapter with a stubbed smoke runner
// - exit 0 on a clean generic adapter with a stubbed smoke runner
// - the five `findObservationDelta` unit tests (primitive-agnostic)

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runAdapt } from "../src/commands/adapt.js";
import { findObservationDelta, type SmokeTestResult } from "../src/adapt/smoke.js";

const LENDING_TOML = `protocol = "lending"

[instructions]
deposit = { action = "deposit", amount = "amount" }
borrow = { action = "borrow", amount = "amount" }
repay = { action = "repay", amount = "amount" }
withdraw = { action = "withdraw", amount = "amount" }
liquidate = { action = "liquidate", amount = "repay_amount" }

[state_mapping]
"pool.total_deposits" = "tvl"
"pool.total_borrows" = "debt"
"position.collateral" = "collateral"

[actions]

[observations]

[personas]
`;

const GENERIC_TOML = `protocol = "generic"
program_so = "programs/resource_grinder/target/deploy/resource_grinder.so"
idl_path = "fixtures/idls/resource-grinder.json"

[accounts.player]
kind = "agent"
space = 48

[instructions]
mine = { action = "mine", amount = "amount" }

[state_mapping]
"player.gold" = "player.gold"

[actions.mine]
label = "Mine"
takes = ["amount"]

[observations]
"player.gold" = "uint"

[personas.grinder]
label = "Grinder"
action_rate_multiplier = 1.0
action_weights = { mine = 1.0 }
triggers = []
`;

const INVALID_TOML = `protocol = "lending"

[instructions]
deposit = { action = "not-a-real-action", amount = "amount" }

[state_mapping]
"pool.total_deposits" = "tvl"

[actions]

[observations]

[personas]
`;

async function writeTempAdapter(contents: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "riptide-adapt-test-"));
  const file = path.join(dir, "adapter.toml");
  await writeFile(file, contents, "utf8");
  return file;
}

const STUB_PASS: SmokeTestResult = {
  passed: true,
  engineExitCode: 0,
  engineStderr: "",
  reason: "stubbed pass",
  outputPath: "/tmp/stub.json"
};

const STUB_FAIL: SmokeTestResult = {
  passed: false,
  engineExitCode: 1,
  engineStderr: "stub engine rejected adapter",
  reason: "stubbed failure",
  outputPath: "/tmp/stub.json"
};

test("adapt: missing adapter file → exit 2", async () => {
  const exit = await runAdapt(
    { adapter: "/nonexistent/path/to/adapter.toml" },
    {
      engineBinary: "/tmp/fake-engine",
      runSmokeTestImpl: async () => STUB_PASS
    }
  );
  assert.equal(exit, 2);
});

test("adapt: adapter fails Zod validation → exit 2", async () => {
  const adapterPath = await writeTempAdapter(INVALID_TOML);
  const exit = await runAdapt(
    { adapter: adapterPath },
    {
      engineBinary: "/tmp/fake-engine",
      runSmokeTestImpl: async () => STUB_PASS
    }
  );
  assert.equal(exit, 2);
});

test("adapt: valid lending adapter + stubbed smoke pass → exit 0", async () => {
  const adapterPath = await writeTempAdapter(LENDING_TOML);
  const exit = await runAdapt(
    { adapter: adapterPath },
    {
      engineBinary: "/tmp/fake-engine",
      runSmokeTestImpl: async () => STUB_PASS
    }
  );
  assert.equal(exit, 0);
});

test("adapt: valid generic adapter + stubbed smoke pass → exit 0", async () => {
  const adapterPath = await writeTempAdapter(GENERIC_TOML);
  const exit = await runAdapt(
    { adapter: adapterPath },
    {
      engineBinary: "/tmp/fake-engine",
      runSmokeTestImpl: async () => STUB_PASS
    }
  );
  assert.equal(exit, 0);
});

test("adapt: valid adapter but smoke test fails → exit 1", async () => {
  const adapterPath = await writeTempAdapter(LENDING_TOML);
  const exit = await runAdapt(
    { adapter: adapterPath },
    {
      engineBinary: "/tmp/fake-engine",
      runSmokeTestImpl: async () => STUB_FAIL
    }
  );
  assert.equal(exit, 1);
});

// --- lint preflight ---

test("adapt: lint preflight aborts before smoke when JSON-IDL lineage fails", async () => {
  // Adapter declares an instruction that is NOT in the JSON IDL.
  // Lint must fail, engine must never spawn. Stub smoke throws to
  // prove we never reached it.
  const { mkdir } = await import("node:fs/promises");
  const repoRoot = await (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), "riptide-adapt-lint-"));
  const adaptersDir = path.join(repoRoot, "fixtures", "adapters");
  const idlsDir = path.join(repoRoot, "fixtures", "idls");
  await mkdir(adaptersDir, { recursive: true });
  await mkdir(idlsDir, { recursive: true });
  await writeFile(
    path.join(idlsDir, "mini.json"),
    JSON.stringify({
      instructions: [
        {
          name: "real_ix",
          accounts: [{ name: "pool" }],
          args: [{ name: "amount", type: "u64" }],
        },
      ],
      accounts: [{ name: "pool", fields: [{ name: "x", type: "u64" }] }],
    }),
    "utf8"
  );
  const adapterPath = path.join(adaptersDir, "adapter.toml");
  await writeFile(
    adapterPath,
    `protocol = "generic"
program_so = "./mini.so"
idl_path = "fixtures/idls/mini.json"

[accounts.pool]
kind = "shared"
space = 64

[instructions]
ghost = { action = "deposit", amount = "amount" }

[state_mapping]
"pool.x" = "pool.x"

[actions.deposit]
label = "Deposit"
takes = ["amount"]

[observations]
"pool.x" = "uint"

[personas.grinder]
label = "Grinder"
action_rate_multiplier = 1.0
action_weights = { deposit = 1.0 }
triggers = []

[lineage]
idl_source = "fixtures/idls/mini.json"
`,
    "utf8"
  );

  let smokeInvoked = false;
  const exit = await runAdapt(
    { adapter: adapterPath },
    {
      engineBinary: "/tmp/fake-engine",
      repoRoot,
      runSmokeTestImpl: async () => {
        smokeInvoked = true;
        return STUB_PASS;
      },
    }
  );

  assert.equal(exit, 2, "lint failure must propagate as exit 2");
  assert.equal(smokeInvoked, false, "smoke test must NOT be spawned after lint FAIL");
});

test("adapt: lint preflight SKIP on adapters without lineage → continues to smoke", async () => {
  const adapterPath = await writeTempAdapter(LENDING_TOML);
  let smokeInvoked = false;
  const exit = await runAdapt(
    { adapter: adapterPath },
    {
      engineBinary: "/tmp/fake-engine",
      runSmokeTestImpl: async () => {
        smokeInvoked = true;
        return STUB_PASS;
      },
    }
  );
  assert.equal(exit, 0);
  assert.equal(smokeInvoked, true, "lint SKIP path must still spawn smoke");
});

// --- findObservationDelta unit tests (primitive-agnostic) ---

test("findObservationDelta: rejects a baseline-only summary with empty events + empty timeseries", () => {
  const fake = {
    summary: { final_tvl: 0 },
    events: [],
    timeseries: []
  };
  const delta = findObservationDelta(fake);
  assert.equal(delta, null, "a populated summary alone must NOT count as a state delta");
});

test("findObservationDelta: accepts a successful deposit event", () => {
  const fake = {
    summary: {},
    events: [
      { tick: 0, action: "deposit", outcome: "success", params: { amount: 1000 } }
    ],
    timeseries: []
  };
  const delta = findObservationDelta(fake);
  assert.ok(delta && delta.includes("deposit"), `expected deposit delta, got: ${delta}`);
});

test("findObservationDelta: rejects a trigger_activated event as a write-action proof", () => {
  const fake = {
    summary: {},
    events: [
      { tick: 0, action: "trigger_activated", outcome: "success" },
      { tick: 0, action: "skipped", outcome: "success" }
    ],
    timeseries: []
  };
  assert.equal(findObservationDelta(fake), null);
});

test("findObservationDelta: accepts a timeseries field that changed between first and last tick", () => {
  const fake = {
    summary: {},
    events: [],
    timeseries: [
      { tick: 0, tvl: 1000000, utilization: 0.45 },
      { tick: 9, tvl: 1050000, utilization: 0.48 }
    ]
  };
  const delta = findObservationDelta(fake);
  assert.ok(delta && delta.includes("tvl"));
});

test("findObservationDelta: rejects a timeseries where nothing actually changed", () => {
  const fake = {
    summary: {},
    events: [],
    timeseries: [
      { tick: 0, tvl: 0, utilization: 0 },
      { tick: 1, tvl: 0, utilization: 0 }
    ]
  };
  assert.equal(findObservationDelta(fake), null);
});
