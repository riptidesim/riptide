// `riptide adapt` integration tests (Sprint 3 · T07).
//
// These tests exercise the adapt command against a fake LLM client and
// a stubbed smoke-test runner. They cover:
//   - happy path lending classification → generation → smoke-pass → 0
//   - happy path generic classification → generation → smoke-pass → 0
//   - validation failure on first attempt → retry → pass → 0
//   - validation failure on both attempts → 1 + raw adapter still written
//   - missing endpoint / API key → 2
//   - smoke-test failure → 1
//
// No real network. No real engine binary.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runAdapt } from "../src/commands/adapt.js";
import type { ChatMessage, LlmClient } from "../src/llm/openai-compat.js";
import { LlmNetworkError } from "../src/llm/openai-compat.js";
import type { PromptBundle } from "../src/llm/prompts.js";
import { findObservationDelta, type SmokeTestResult } from "../src/llm/smoke-test.js";

const DUMMY_PROMPTS: PromptBundle = {
  classify: "classify",
  generateLending: "generate lending",
  generateGeneric: "generate generic",
  retrySuffix: "retry:\n{{previous}}\n{{error}}\n"
};

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

interface ScriptedResponse {
  output: string;
}

function scriptedClient(responses: ScriptedResponse[]): {
  client: LlmClient;
  callCount: () => number;
  lastMessages: () => ChatMessage[] | null;
} {
  let index = 0;
  let lastMessages: ChatMessage[] | null = null;
  const client: LlmClient = {
    async complete(messages: ChatMessage[]) {
      lastMessages = messages;
      const next = responses[index++];
      if (!next) {
        throw new Error(`scriptedClient: no scripted response for call #${index}`);
      }
      return next.output;
    }
  };
  return {
    client,
    callCount: () => index,
    lastMessages: () => lastMessages
  };
}

async function makeIdlFile(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "riptide-adapt-test-"));
  const file = path.join(dir, "idl.json");
  await writeFile(
    file,
    JSON.stringify({
      instructions: [{ name: "deposit", args: [{ name: "amount", type: "u64" }] }],
      accounts: [
        { name: "pool", fields: [{ name: "total_deposits", type: "u64" }] }
      ]
    }),
    "utf8"
  );
  return file;
}

function baseOptions(out: string, idl: string) {
  return {
    idl,
    out,
    endpoint: "http://mock",
    model: "mock",
    apiKeyEnv: "MOCK_KEY",
    skipSmoke: false as boolean
  };
}

function withEnv<T>(key: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  return fn().finally(() => {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  });
}

test("adapt: lending happy path, smoke pass → exit 0", async () => {
  const idl = await makeIdlFile();
  const outDir = await mkdtemp(path.join(os.tmpdir(), "riptide-adapt-out-"));
  const out = path.join(outDir, "adapter.toml");

  const { client } = scriptedClient([
    { output: JSON.stringify({ classification: "lending", reason: "five lending actions" }) },
    { output: LENDING_TOML }
  ]);

  const exit = await withEnv("MOCK_KEY", "sk-mock", () =>
    runAdapt(baseOptions(out, idl), {
      createClient: () => client,
      prompts: DUMMY_PROMPTS,
      runSmokeTestImpl: async (): Promise<SmokeTestResult> => ({
        passed: true,
        engineExitCode: 0,
        engineStderr: "",
        reason: "stubbed pass",
        outputPath: "/tmp/stub.json"
      })
    })
  );

  assert.equal(exit, 0);
  const written = await readFile(out, "utf8");
  assert.ok(written.includes(`protocol = "lending"`));
});

test("adapt: generic happy path → exit 0", async () => {
  const idl = await makeIdlFile();
  const outDir = await mkdtemp(path.join(os.tmpdir(), "riptide-adapt-out-"));
  const out = path.join(outDir, "adapter.toml");

  const { client } = scriptedClient([
    { output: JSON.stringify({ classification: "generic", reason: "non-lending" }) },
    { output: GENERIC_TOML }
  ]);

  const exit = await withEnv("MOCK_KEY", "sk-mock", () =>
    runAdapt(baseOptions(out, idl), {
      createClient: () => client,
      prompts: DUMMY_PROMPTS,
      runSmokeTestImpl: async (): Promise<SmokeTestResult> => ({
        passed: true,
        engineExitCode: 0,
        engineStderr: "",
        reason: "stubbed pass",
        outputPath: "/tmp/stub.json"
      })
    })
  );

  assert.equal(exit, 0);
  const written = await readFile(out, "utf8");
  assert.ok(written.includes(`protocol = "generic"`));
});

test("adapt: first attempt invalid, retry passes → exit 0", async () => {
  const idl = await makeIdlFile();
  const outDir = await mkdtemp(path.join(os.tmpdir(), "riptide-adapt-out-"));
  const out = path.join(outDir, "adapter.toml");

  const { client, callCount } = scriptedClient([
    { output: JSON.stringify({ classification: "lending", reason: "" }) },
    { output: INVALID_TOML }, // first generation — rejected by validator
    { output: LENDING_TOML } // retry — passes
  ]);

  const exit = await withEnv("MOCK_KEY", "sk-mock", () =>
    runAdapt(baseOptions(out, idl), {
      createClient: () => client,
      prompts: DUMMY_PROMPTS,
      runSmokeTestImpl: async (): Promise<SmokeTestResult> => ({
        passed: true,
        engineExitCode: 0,
        engineStderr: "",
        reason: "stubbed pass",
        outputPath: "/tmp/stub.json"
      })
    })
  );

  assert.equal(exit, 0);
  assert.equal(callCount(), 3);
  const written = await readFile(out, "utf8");
  assert.ok(written.includes(`deposit`));
  assert.ok(!written.includes(`not-a-real-action`));
});

test("adapt: both generation attempts invalid → exit 1 + raw adapter written", async () => {
  const idl = await makeIdlFile();
  const outDir = await mkdtemp(path.join(os.tmpdir(), "riptide-adapt-out-"));
  const out = path.join(outDir, "adapter.toml");

  const { client } = scriptedClient([
    { output: JSON.stringify({ classification: "lending", reason: "" }) },
    { output: INVALID_TOML },
    { output: INVALID_TOML }
  ]);

  const exit = await withEnv("MOCK_KEY", "sk-mock", () =>
    runAdapt(baseOptions(out, idl), {
      createClient: () => client,
      prompts: DUMMY_PROMPTS,
      runSmokeTestImpl: async (): Promise<SmokeTestResult> => ({
        passed: true,
        engineExitCode: 0,
        engineStderr: "",
        reason: "never called",
        outputPath: "/tmp/stub.json"
      })
    })
  );

  assert.equal(exit, 1);
  const written = await readFile(out, "utf8");
  assert.ok(written.includes(`not-a-real-action`), "raw adapter should still be written on retry failure");
});

test("adapt: smoke test fails → exit 1", async () => {
  const idl = await makeIdlFile();
  const outDir = await mkdtemp(path.join(os.tmpdir(), "riptide-adapt-out-"));
  const out = path.join(outDir, "adapter.toml");

  const { client } = scriptedClient([
    { output: JSON.stringify({ classification: "lending", reason: "" }) },
    { output: LENDING_TOML }
  ]);

  const exit = await withEnv("MOCK_KEY", "sk-mock", () =>
    runAdapt(baseOptions(out, idl), {
      createClient: () => client,
      prompts: DUMMY_PROMPTS,
      runSmokeTestImpl: async (): Promise<SmokeTestResult> => ({
        passed: false,
        engineExitCode: 1,
        engineStderr: "stub engine rejected adapter",
        reason: "stubbed failure",
        outputPath: "/tmp/stub.json"
      })
    })
  );

  assert.equal(exit, 1);
});

test("adapt: missing API key → exit 2", async () => {
  const idl = await makeIdlFile();
  const outDir = await mkdtemp(path.join(os.tmpdir(), "riptide-adapt-out-"));
  const out = path.join(outDir, "adapter.toml");

  const exit = await withEnv("MOCK_KEY", undefined, () =>
    runAdapt(baseOptions(out, idl), {
      prompts: DUMMY_PROMPTS
    })
  );

  assert.equal(exit, 2);
});

test("adapt: network error during classification → exit 2", async () => {
  const idl = await makeIdlFile();
  const outDir = await mkdtemp(path.join(os.tmpdir(), "riptide-adapt-out-"));
  const out = path.join(outDir, "adapter.toml");

  const erroringClient: LlmClient = {
    async complete(): Promise<string> {
      throw new LlmNetworkError("ECONNREFUSED");
    }
  };

  const exit = await withEnv("MOCK_KEY", "sk-mock", () =>
    runAdapt(baseOptions(out, idl), {
      createClient: () => erroringClient,
      prompts: DUMMY_PROMPTS
    })
  );

  assert.equal(exit, 2);
});

test("findObservationDelta: rejects a baseline-only summary with empty events + empty timeseries (Phase 4 review regression)", () => {
  const fake = {
    summary: { final_tvl: 0 },
    events: [],
    timeseries: []
  };
  const delta = findObservationDelta(fake);
  assert.equal(
    delta,
    null,
    "a populated summary alone must NOT count as a state delta"
  );
});

test("findObservationDelta: accepts a successful deposit event", () => {
  const fake = {
    summary: {},
    events: [
      {
        tick: 0,
        action: "deposit",
        outcome: "success",
        params: { amount: 1000 }
      }
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

test("adapt: --skip-smoke short-circuits → exit 0 without engine call", async () => {
  const idl = await makeIdlFile();
  const outDir = await mkdtemp(path.join(os.tmpdir(), "riptide-adapt-out-"));
  const out = path.join(outDir, "adapter.toml");

  const { client } = scriptedClient([
    { output: JSON.stringify({ classification: "lending", reason: "" }) },
    { output: LENDING_TOML }
  ]);

  let smokeCalled = false;
  const exit = await withEnv("MOCK_KEY", "sk-mock", () =>
    runAdapt({ ...baseOptions(out, idl), skipSmoke: true }, {
      createClient: () => client,
      prompts: DUMMY_PROMPTS,
      runSmokeTestImpl: async (): Promise<SmokeTestResult> => {
        smokeCalled = true;
        return {
          passed: false,
          engineExitCode: 1,
          engineStderr: "",
          reason: "",
          outputPath: ""
        };
      }
    })
  );

  assert.equal(exit, 0);
  assert.equal(smokeCalled, false);
});
