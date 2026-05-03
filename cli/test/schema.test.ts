import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  PolicySchema,
  RunConfigSchema,
  SimulationResultSchema,
  SimulationSummarySchema,
  TickSnapshotSchema
} from "../src/compiler/schema.js";

async function readFixture(name: string): Promise<unknown> {
  const fixturePath = path.resolve(process.cwd(), "../fixtures", name);
  const raw = await readFile(fixturePath, "utf8");
  return JSON.parse(raw);
}

test("PolicySchema validates the shared policy fixture", async () => {
  const fixture = await readFixture("policy.sample.json");
  const policy = PolicySchema.parse(fixture);

  assert.equal(policy.persona_id, "cautious-yield-farmer");
  assert.equal(policy.triggers.length, 5);
});

test("RunConfigSchema validates the shared run config fixture", async () => {
  const fixture = await readFixture("run-config.sample.json");
  const runConfig = RunConfigSchema.parse(fixture);

  assert.equal(runConfig.agents, 5);
  assert.equal(runConfig.personas.length, 2);
});

test("RunConfigSchema accepts persona count maps and expands them deterministically", () => {
  const runConfig = RunConfigSchema.parse({
    agents: 3,
    ticks: 1,
    scenario: "baseline",
    personas: {
      whale: 2,
      liquidator: 1
    },
    validator_url: "unused",
    output_path: "out"
  });

  assert.deepEqual(runConfig.personas, ["whale", "whale", "liquidator"]);
});

test("RunConfigSchema rejects persona count maps that do not match agents", () => {
  const parsed = RunConfigSchema.safeParse({
    agents: 3,
    ticks: 1,
    scenario: "baseline",
    personas: {
      whale: 2
    },
    validator_url: "unused",
    output_path: "out"
  });

  assert.equal(parsed.success, false);
});

test("RunConfigSchema rejects all-zero persona count maps when agents are required", () => {
  const parsed = RunConfigSchema.safeParse({
    agents: 3,
    ticks: 1,
    scenario: "baseline",
    personas: {
      whale: 0
    },
    validator_url: "unused",
    output_path: "out"
  });

  assert.equal(parsed.success, false);
});

test("SimulationResultSchema validates the shared simulation result fixture", async () => {
  const fixture = await readFixture("simulation-result.sample.json");
  const result = SimulationResultSchema.parse(fixture);

  assert.equal(result.total_ticks, 10);
  assert.equal(result.events.length, 2);
});

// The record-based schemas must still enforce nonnegative-integer
// shape on the engine-owned counters. Regression tests for a review
// finding that an earlier schema pass accepted negative/fractional
// values and dropped the `agents_liquidated` / `agents_depleted`
// checks.

test("TickSnapshotSchema accepts a well-formed lending-shaped entry", () => {
  const parsed = TickSnapshotSchema.safeParse({
    tick: 3,
    active_agents: 5,
    tvl: 500.0,
    utilization: 0.4,
    oracle_price: 100.0,
    cumulative_liquidations: 0,
    cumulative_bad_debt: 0.0
  });
  assert.equal(parsed.success, true);
});

test("TickSnapshotSchema accepts a well-formed generic-shaped entry", () => {
  const parsed = TickSnapshotSchema.safeParse({
    tick: 7,
    active_agents: 6,
    "player.gold": 0.5,
    "player.wood": 2.17,
    "marketplace.listings": 3.0
  });
  assert.equal(parsed.success, true);
});

test("TickSnapshotSchema rejects a fractional tick", () => {
  const parsed = TickSnapshotSchema.safeParse({ tick: -1.5, active_agents: -2 });
  assert.equal(parsed.success, false);
});

test("TickSnapshotSchema rejects a negative tick", () => {
  const parsed = TickSnapshotSchema.safeParse({ tick: -1, active_agents: 1 });
  assert.equal(parsed.success, false);
});

test("TickSnapshotSchema rejects a fractional active_agents", () => {
  const parsed = TickSnapshotSchema.safeParse({ tick: 0, active_agents: 2.5 });
  assert.equal(parsed.success, false);
});

test("TickSnapshotSchema rejects a missing active_agents", () => {
  const parsed = TickSnapshotSchema.safeParse({ tick: 0 });
  assert.equal(parsed.success, false);
});

test("TickSnapshotSchema accepts derived observations", () => {
  const parsed = TickSnapshotSchema.safeParse({
    tick: 0,
    active_agents: 1,
    derived_observations: {
      collateral_value: 1000,
      health_factor: "115792089237316195423570985008687907853"
    }
  });
  assert.equal(parsed.success, true);
});

test("TickSnapshotSchema accepts collection observations with empty sentinels", () => {
  const parsed = TickSnapshotSchema.safeParse({
    tick: 0,
    active_agents: 1,
    derived_observations: { health_factor: 0.8 },
    collection_observations: {
      worst_health_factor: 0.8,
      empty_positions: {
        evaluation_error: [
          {
            type: "EmptyCollection",
            message: "collection `empty_positions` over `positions` is empty"
          }
        ]
      }
    }
  });
  assert.equal(parsed.success, true);
});

test("SimulationSummarySchema accepts a well-formed lending summary", () => {
  const parsed = SimulationSummarySchema.safeParse({
    agents_active: 5,
    agents_liquidated: 0,
    agents_depleted: 0,
    final_tvl: 633.0,
    final_utilization: 7.898894154818326,
    total_liquidations: 0,
    total_bad_debt: 0.0,
    largest_single_tick_drawdown: 0.00358360567624929
  });
  assert.equal(parsed.success, true);
});

test("SimulationSummarySchema accepts a well-formed generic summary", () => {
  const parsed = SimulationSummarySchema.safeParse({
    agents_active: 6,
    agents_liquidated: 0,
    agents_depleted: 0,
    "player.gold_avg": 0.38,
    "player.gold_max": 0.67,
    "player.gold_min": 0.0
  });
  assert.equal(parsed.success, true);
});

test("SimulationSummarySchema accepts an invariants_fired array (replay surface)", () => {
  // re-review #1: the Solend replay exits 1 with this shape
  // in `summary.invariants_fired`. Previously the CLI Zod schema only
  // allowed scalar union values and choked on the array, which broke
  // the user-facing `riptide replay` wrapper. Lock the fix so future
  // schema drift surfaces here first.
  const parsed = SimulationSummarySchema.safeParse({
    agents_active: 10,
    agents_liquidated: 0,
    agents_depleted: 0,
    final_tvl: 500.0,
    total_bad_debt: 3600.0,
    invariants_fired: [
      {
        name: "no_bad_debt",
        field: "bad_debt",
        op: "==",
        value: 0,
        firings: 1
      }
    ]
  });
  assert.equal(parsed.success, true);
});

test("SimulationSummarySchema accepts expression invariant rows with observed cap", () => {
  const parsed = SimulationSummarySchema.safeParse({
    agents_active: 1,
    agents_liquidated: 0,
    agents_depleted: 0,
    expression_invariants: [
      {
        name: "ltv_below_max",
        expr: "debt_value <= max_borrow_value",
        severity: "warn",
        first_tick: 0,
        firing_count: 4,
        first_fired_tick: 0,
        firings: 4,
        observed: [
          { tick: 0, values: { debt_value: 800, max_borrow_value: 700 } },
          { tick: 1, values: { debt_value: 800, max_borrow_value: 700 } },
          { tick: 2, values: { debt_value: 800, max_borrow_value: 700 } }
        ]
      }
    ]
  });
  assert.equal(parsed.success, true);
});

test("SimulationResultSchema accepts top-level semantics contract", () => {
  const parsed = SimulationResultSchema.safeParse({
    run_config: {
      agents: 1,
      ticks: 1,
      scenario: "semantic",
      seed: 1,
      personas: ["semantic-lp"],
      validator_url: "unused",
      output_path: "out"
    },
    seed: 1,
    total_ticks: 1,
    timeseries: [
      {
        tick: 0,
        active_agents: 1,
        derived_observations: { debt_value: 800 }
      }
    ],
    replay_provenance: {
      pack_path: "fixtures/state-pack-demo",
      slot: 42,
      accounts: {
        reserve: {
          account_pubkey: "11111111111111111111111111111111",
          sha256_hash: "f8e793de1e562588466e818bf28e3be9c39d6ad527c0c21322359a16508043f8"
        }
      }
    },
    events: [],
    agents: [],
    summary: {
      agents_active: 1,
      agents_liquidated: 0,
      agents_depleted: 0
    },
    semantics: {
      class: "lending.v1",
      roles_bound: [{ role_name: "position", source: "instruction.deposit_or_borrow" }],
      derived_observation_definitions: [
        { name: "debt_value", expr: "position.debt_amount" }
      ]
    },
    simulation_boundaries: []
  });
  assert.equal(parsed.success, true);
});

test("SimulationResultSchema rejects malformed replay provenance hashes", () => {
  const parsed = SimulationResultSchema.safeParse({
    run_config: {
      agents: 1,
      ticks: 1,
      scenario: "semantic",
      seed: 1,
      personas: ["semantic-lp"],
      validator_url: "unused",
      output_path: "out"
    },
    seed: 1,
    total_ticks: 1,
    timeseries: [{ tick: 0, active_agents: 1 }],
    events: [],
    agents: [],
    summary: {
      agents_active: 1,
      agents_liquidated: 0,
      agents_depleted: 0
    },
    replay_provenance: {
      pack_path: "fixtures/state-pack-demo",
      slot: 42,
      accounts: {
        reserve: {
          account_pubkey: "11111111111111111111111111111111",
          sha256_hash: "not-a-sha256"
        }
      }
    },
    simulation_boundaries: []
  });
  assert.equal(parsed.success, false);
});

test("SimulationSummarySchema rejects a malformed invariants_fired row", () => {
  // Array-of-unknown would defeat the gate — every row must match
  // InvariantFiredRowSchema. Drop a required field and confirm the
  // schema rejects rather than silently passing.
  const parsed = SimulationSummarySchema.safeParse({
    agents_active: 10,
    agents_liquidated: 0,
    agents_depleted: 0,
    invariants_fired: [
      { name: "no_bad_debt", field: "bad_debt", op: "==", value: 0 }
    ]
  });
  assert.equal(parsed.success, false);
});

test("SimulationSummarySchema rejects a negative firings count", () => {
  const parsed = SimulationSummarySchema.safeParse({
    agents_active: 10,
    agents_liquidated: 0,
    agents_depleted: 0,
    invariants_fired: [
      {
        name: "no_bad_debt",
        field: "bad_debt",
        op: "==",
        value: 0,
        firings: -1
      }
    ]
  });
  assert.equal(parsed.success, false);
});

test("SimulationSummarySchema rejects a fractional agents_active", () => {
  const parsed = SimulationSummarySchema.safeParse({
    agents_active: -3.5,
    agents_liquidated: 0,
    agents_depleted: 0
  });
  assert.equal(parsed.success, false);
});

test("SimulationSummarySchema rejects a negative agents_active", () => {
  const parsed = SimulationSummarySchema.safeParse({
    agents_active: -1,
    agents_liquidated: 0,
    agents_depleted: 0
  });
  assert.equal(parsed.success, false);
});

test("SimulationSummarySchema requires agents_liquidated", () => {
  const parsed = SimulationSummarySchema.safeParse({
    agents_active: 5,
    agents_depleted: 0
  });
  assert.equal(parsed.success, false);
});

test("SimulationSummarySchema requires agents_depleted", () => {
  const parsed = SimulationSummarySchema.safeParse({
    agents_active: 5,
    agents_liquidated: 0
  });
  assert.equal(parsed.success, false);
});
