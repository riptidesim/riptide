// `riptide explain` command tests.
//
// Covers:
// - byte-for-byte rendering of a rich parsed adapter
// - stable empty-section output
// - omitted semantics section when no `[semantics]` block is present
// - shared adapter resolution / validation error surfaces

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { renderAdapterExplain, runExplain } from "../src/commands/explain.js";
import type { Adapter } from "../src/schemas/adapter.js";

const FULL_ADAPTER: Adapter = {
  protocol: "generic",
  program_so: "../programs/demo/target/deploy/demo.so",
  idl_path: "../idls/demo.json",
  accounts: {
    reserve: {
      kind: "shared",
      space: 128,
      owner: { program_so: "../programs/oracle/target/deploy/oracle.so" },
    },
    position: {
      kind: "agent",
      space: 96,
      pda: { seeds: ["literal:position", "signer:agent"], program: "self" },
    },
  },
  instructions: {
    deposit: { action: "deposit", amount: "collateral_amount", args: {}, bindings: {} },
    borrow: {
      action: "borrow",
      amount: "debt_amount",
      args: { interest_index_bps: 0 },
      bindings: {},
    },
  },
  state_mapping: {
    "pool.total_deposits": "tvl",
    "position.health": "health_factor",
  },
  actions: {
    deposit: {
      label: "Deposit collateral",
      takes: ["user_token_account", "reserve", "position"],
    },
    withdraw: {
      takes: ["user_token_account", "reserve", "position"],
    },
  },
  observations: {
    tvl: { type: "uint", label: "Total value locked" },
    utilization: "uint",
    cumulative_bad_debt: "uint",
  },
  personas: {
    "steady-lp": {
      action_rate_multiplier: 1,
      action_weights: { deposit: 0.7, withdraw: 0.3 },
      triggers: [],
      persona_args: {},
    },
    "panic-whale": {
      label: "Panic whale",
      action_rate_multiplier: 2.5,
      action_weights: { withdraw: 1 },
      triggers: [
        { if: "utilization > 90", then: "withdraw", weight_boost: 3 },
      ],
      persona_args: { side: "short" },
    },
  },
  invariants: [
    { field: "cumulative_bad_debt", op: "==", value: 0 },
    { name: "active_agents_positive", field: "active_agents", op: ">", value: 0 },
  ],
  semantics: {
    class: "lending.v1",
    roles: {
      position: {
        source: "instruction.deposit_or_borrow",
        fields: { collateral_amount: "u128", debt_amount: "u128" },
      },
      reserve: {
        source: "account.reserve",
        fields: {
          collateral_price: "u128",
          max_ltv_bps: "u64",
        },
      },
      oracle: {
        source: "account.oracle",
        fields: { confidence: "u128", price: "u128" },
      },
      liquidation_config: {
        source: "account.reserve",
        fields: { liquidation_threshold_bps: "u64" },
      },
    },
    derived: {
      collateral_value: "position.collateral_amount * reserve.collateral_price",
      debt_value: "position.debt_amount",
      health_factor: "liquidation_threshold_value / max(debt_value, 1)",
    },
    invariants: [
      {
        name: "health_factor_positive",
        expr: "health_factor > 1.0",
        severity: "warn",
        description: "Health factor should stay above one",
      },
    ],
    extensions: { note: "demo" },
    oracles: {
      oracle: [
        {
          program_id: "11111111111111111111111111111111",
          account: "22222222222222222222222222222222",
          confidence: "oracle.confidence",
          staleness: "oracle.staleness",
          weight: 100,
        },
      ],
    },
    collections: {
      worst_health_factor: {
        over: "reserves",
        formula: "worst",
        expr: "collateral_value / max(debt_value, 1)",
      },
    },
    replay: {
      state_source: "fixture",
      pack_path: "packs/demo",
      slot: 42,
      roles: { reserve: "11111111111111111111111111111111" },
    },
  },
  oracles: [
    {
      name: "sol_usd",
      kind: "admin-mock",
      account: "reserve",
      base_price: 125,
      exponent: -6,
      confidence: 42,
    },
  ],
  scheduled_actions: [
    {
      name: "refresh_reserve",
      instruction: "deposit",
      interval_ticks: 5,
      accounts: ["reserve"],
      args: { amount: 0 },
    },
  ],
  errors: [],
  lineage: {
    idl_source: "fixtures/idls/demo.json",
    generator: "hand-authored",
    inferred_assumptions: ["one reserve per program"],
    unsupported_fields: ["reserve.fee_receiver"],
  },
};

const EMPTY_ADAPTER: Adapter = {
  protocol: "lending",
  instructions: {},
  state_mapping: {},
  accounts: {},
  actions: {},
  observations: {},
  personas: {},
  invariants: [],
  oracles: [],
  scheduled_actions: [],
  errors: [],
};

test("renderAdapterExplain formats a parsed adapter byte-for-byte", () => {
  const actual = renderAdapterExplain("fixture", FULL_ADAPTER);
  const expected = [
    "Adapter — fixture",
    "",
    "Runtime:",
    "  protocol: generic",
    "  program_so: ../programs/demo/target/deploy/demo.so",
    "  program_id: (none; adapter/IDL/keypair inferred)",
    "  idl_path:   ../idls/demo.json",
    "",
    "Accounts:",
    "  position kind=agent; space=96; pda=[\"literal:position\", \"signer:agent\"]; pda_program=self",
    "  reserve kind=shared; space=128; owner=program_so:../programs/oracle/target/deploy/oracle.so",
    "",
    "Instructions:",
    "  borrow → action=borrow, amount=debt_amount, args={interest_index_bps=0}",
    "  deposit → action=deposit, amount=collateral_amount",
    "",
    "State mapping:",
    "  pool.total_deposits → tvl",
    "  position.health → health_factor",
    "",
    "Actions:",
    "  deposit takes=[\"user_token_account\", \"reserve\", \"position\"] label=\"Deposit collateral\"",
    "  withdraw takes=[\"user_token_account\", \"reserve\", \"position\"]",
    "",
    "Observations:",
    "  cumulative_bad_debt uint",
    "  tvl uint label=\"Total value locked\"",
    "  utilization uint",
    "",
    "Personas:",
    "  panic-whale rate=2.5 weights={withdraw:1} triggers=[utilization > 90 -> withdraw (+3)] args={side=\"short\"} label=\"Panic whale\"",
    "  steady-lp rate=1 weights={deposit:0.7, withdraw:0.3}",
    "",
    "Invariants (flat):",
    "  cumulative_bad_debt == 0 [error]",
    "  active_agents_positive: active_agents > 0 [error]",
    "",
    "Semantics:",
    "  class: lending.v1",
    "  Roles:",
    "    liquidation_config source=account.reserve",
    "                       fields={liquidation_threshold_bps: u64}",
    "    oracle             source=account.oracle",
    "                       fields={confidence: u128, price: u128}",
    "    position           source=instruction.deposit_or_borrow",
    "                       fields={collateral_amount: u128, debt_amount: u128}",
    "    reserve            source=account.reserve",
    "                       fields={collateral_price: u128, max_ltv_bps: u64}",
    "  Derived:",
    "    collateral_value = position.collateral_amount * reserve.collateral_price",
    "    debt_value = position.debt_amount",
    "    health_factor = liquidation_threshold_value / max(debt_value, 1)",
    "  Collections:",
    "    worst_health_factor over=reserves formula=worst expr=\"collateral_value / max(debt_value, 1)\"",
    "  Oracle bindings:",
    "    oracle[0] program_id=11111111111111111111111111111111 account=22222222222222222222222222222222 confidence=oracle.confidence staleness=oracle.staleness weight=100",
    "  Replay: state_source=fixture pack_path=packs/demo slot=42 roles={reserve=11111111111111111111111111111111}",
    "  Extensions:",
    "    note = \"demo\"",
    "  Invariants (semantic):",
    "    health_factor_positive expr=\"health_factor > 1.0\" [warn] description=\"Health factor should stay above one\"",
    "",
    "Oracles:",
    "  sol_usd kind=admin-mock base=125 expo=-6 account=reserve confidence=42",
    "",
    "Scheduled actions:",
    "  refresh_reserve every 5 ticks instruction=deposit accounts=[\"reserve\"] args={amount=0}",
    "",
    "Lineage — fixture",
    "",
    "IDL source:",
    "  fixtures/idls/demo.json",
    "",
    "Generator:",
    "  hand-authored",
    "",
    "Inferred assumptions:",
    "  - one reserve per program",
    "",
    "Unsupported fields:",
    "  - reserve.fee_receiver",
    "",
    "Inspection only — no IDL fetch, no validation against IDL. Sprint 13's adapter linter consumes this metadata.",
    "",
  ].join("\n");

  assert.equal(actual, expected);
});

test("renderAdapterExplain emits stable none lines for empty sections", () => {
  const output = renderAdapterExplain("empty", EMPTY_ADAPTER);

  for (const heading of [
    "Accounts:",
    "Instructions:",
    "State mapping:",
    "Actions:",
    "Observations:",
    "Personas:",
    "Invariants (flat):",
    "Oracles:",
    "Scheduled actions:",
  ]) {
    assert.match(output, new RegExp(`${escapeRegExp(heading)}\\n {2}\\(none declared\\)`));
  }
});

test("renderAdapterExplain omits semantics when the adapter has no semantics block", () => {
  const output = renderAdapterExplain("empty", EMPTY_ADAPTER);

  assert.doesNotMatch(output, /\nSemantics:\n/);
  assert.match(output, /no lineage recorded for `empty`; pre-dates the lineage surface/);
});

test("runExplain renders the shipping lending adapter", async () => {
  const fixturesRoot = path.resolve(process.cwd(), "..", "fixtures");
  let stdoutBuf = "";
  let stderrBuf = "";

  const exit = await runExplain(
    "lending",
    {},
    {
      fixturesRoot,
      stdoutWrite: (c) => { stdoutBuf += c; },
      stderrWrite: (c) => { stderrBuf += c; },
    }
  );

  assert.equal(exit, 0, `expected 0, got ${exit}. stderr: ${stderrBuf}`);
  assert.equal(stderrBuf, "");
  assert.match(stdoutBuf, /^Adapter — lending\n/);
  assert.match(stdoutBuf, /Runtime:\n {2}protocol: lending/);
  assert.match(stdoutBuf, /Accounts:\n {2}\(none declared\)/);
  assert.match(stdoutBuf, /Instructions:\n(?:.|\n)*deposit → action=deposit/);
  assert.match(stdoutBuf, /Observations:\n {2}\(none declared\)/);
  assert.match(stdoutBuf, /Personas:\n {2}\(none declared\)/);
  assert.match(stdoutBuf, /Invariants \(flat\):\n {2}\(none declared\)/);
  assert.match(stdoutBuf, /Semantics:\n {2}class: lending\.v1/);
  assert.match(stdoutBuf, /Lineage — lending/);
});

test("runExplain exits 2 when the adapter cannot be resolved", async () => {
  const fixturesRoot = await mkdtemp(path.join(os.tmpdir(), "riptide-explain-missing-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "riptide-explain-cwd-"));
  let stdoutBuf = "";
  let stderrBuf = "";

  const exit = await runExplain(
    "not-a-real-adapter",
    {},
    {
      cwd,
      fixturesRoot,
      stdoutWrite: (c) => { stdoutBuf += c; },
      stderrWrite: (c) => { stderrBuf += c; },
    }
  );

  assert.equal(exit, 2);
  assert.equal(stdoutBuf, "");
  assert.match(stderrBuf, /adapter not found for `not-a-real-adapter`/);
});

test("runExplain exits 2 when adapter validation fails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "riptide-explain-invalid-"));
  const adapterPath = path.join(dir, "bad.toml");
  await writeFile(adapterPath, `protocol = "bogus"\n`, "utf8");
  let stdoutBuf = "";
  let stderrBuf = "";

  const exit = await runExplain(
    adapterPath,
    {},
    {
      stdoutWrite: (c) => { stdoutBuf += c; },
      stderrWrite: (c) => { stderrBuf += c; },
    }
  );

  assert.equal(exit, 2);
  assert.equal(stdoutBuf, "");
  assert.match(stderrBuf, /adapter failed validation/);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
