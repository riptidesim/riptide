import test from "node:test";
import assert from "node:assert/strict";

import type { SimulationResult } from "../src/compiler/schema.js";
import type { ScenarioRecord } from "../src/run/last-run.js";
import {
  interpretScenarioResult,
  type RunInterpretation
} from "../src/run/interpretation.js";

function baseResult(overrides: Partial<SimulationResult> = {}): SimulationResult {
  const result: SimulationResult = {
    run_config: {
      agents: 2,
      ticks: 4,
      scenario: "baseline",
      seed: 7,
      personas: ["cautious-yield-farmer"],
      validator_url: "http://localhost:8899",
      output_path: ".riptide/runs/baseline"
    },
    seed: 7,
    total_ticks: 4,
    timeseries: [
      { tick: 0, active_agents: 2, tvl: 100, utilization: 0.1 },
      { tick: 4, active_agents: 2, tvl: 125, utilization: 0.2 }
    ],
    events: [
      {
        tick: 1,
        agent_id: "agent-001",
        persona_id: "cautious-yield-farmer",
        persona_label: "Cautious Yield Farmer",
        action: "deposit",
        params: { amount: 25 },
        outcome: "success"
      }
    ],
    agents: [
      {
        agent_id: "agent-001",
        persona_id: "cautious-yield-farmer",
        persona_label: "Cautious Yield Farmer",
        status: "active",
        final_balance: 101,
        pnl: 1,
        total_actions: 1,
        triggers_activated: 0
      },
      {
        agent_id: "agent-002",
        persona_id: "cautious-yield-farmer",
        persona_label: "Cautious Yield Farmer",
        status: "active",
        final_balance: 99,
        pnl: -1,
        total_actions: 0,
        triggers_activated: 0
      }
    ],
    summary: {
      final_tvl: 125,
      final_utilization: 0.2,
      agents_active: 2,
      agents_liquidated: 0,
      agents_depleted: 0,
      invariants_fired: [
        { name: "no_bad_debt", field: "bad_debt", op: "==", value: 0, firings: 0 }
      ]
    },
    simulation_boundaries: ["unit test"]
  };

  return {
    ...result,
    ...overrides,
    run_config: { ...result.run_config, ...overrides.run_config },
    summary: { ...result.summary, ...overrides.summary }
  };
}

function baseRecord(overrides: Partial<ScenarioRecord> = {}): ScenarioRecord {
  return {
    name: "baseline",
    run_config_path: "/repo/.riptide/scenarios/baseline/run-config.json",
    status: "pass",
    wall_clock_s: 0.25,
    invariant_fires: [],
    artifacts_dir: ".riptide/runs/baseline",
    ...overrides
  };
}

function interpret(
  record: ScenarioRecord,
  result: SimulationResult | null,
  extra: Partial<Parameters<typeof interpretScenarioResult>[0]> = {}
): RunInterpretation {
  return interpretScenarioResult({
    record,
    result,
    declaredInvariants: ["no_bad_debt"],
    artifactReadability: { simulationResultJson: true, reportMarkdown: true },
    ...extra
  });
}

function checkStatus(
  interpretation: RunInterpretation,
  name: string
): string {
  const check = interpretation.coverage_checks.find((entry) => entry.name === name);
  assert.ok(check, `missing coverage check ${name}`);
  return check.status;
}

function assertNoForbiddenInterpretationText(interpretation: RunInterpretation): void {
  const text = [
    interpretation.summary,
    interpretation.next_action,
    ...interpretation.evidence,
    ...interpretation.reasons,
    ...interpretation.coverage_checks.map((check) => check.detail)
  ].join("\n");
  for (const term of ["safe", "unsafe", "audited", "production-ready", "risk-free"]) {
    assert.doesNotMatch(text, new RegExp(`\\b${term}\\b`, "i"));
  }
}

test("classifies invariant fires as failure observed with exercised coverage", () => {
  const result = baseResult({
    events: [
      ...baseResult().events,
      {
        tick: 3,
        agent_id: "__engine__",
        persona_id: "invariant",
        persona_label: "invariant",
        action: "invariant_violation:no_bad_debt",
        params: {},
        outcome: "failed"
      }
    ],
    summary: {
      invariants_fired: [
        { name: "no_bad_debt", field: "bad_debt", op: "==", value: 0, firings: 1 }
      ]
    }
  });
  const record = baseRecord({
    status: "fail",
    invariant_fires: [{ name: "no_bad_debt", tick: 3 }]
  });

  const interpretation = interpret(record, result);

  assert.equal(interpretation.verdict, "failure-observed");
  assert.equal(interpretation.confidence, "high");
  assert.equal(interpretation.coverage, "exercised");
  assert.equal(interpretation.severity, "critical");
  assert.equal(checkStatus(interpretation, "invariant_inventory"), "pass");
  assert.match(interpretation.summary, /Failure observed in this run/);
  assertNoForbiddenInterpretationText(interpretation);
});

test("classifies clean exercised runs as no failure observed", () => {
  const interpretation = interpret(baseRecord(), baseResult());

  assert.equal(interpretation.verdict, "no-failure-observed");
  assert.equal(interpretation.confidence, "medium");
  assert.equal(interpretation.coverage, "exercised");
  assert.equal(interpretation.severity, "info");
  assert.equal(checkStatus(interpretation, "event_stream"), "pass");
  assert.equal(checkStatus(interpretation, "state_movement"), "pass");
  assertNoForbiddenInterpretationText(interpretation);
});

test("accepts inline adapter personas when the result has agents and events", () => {
  const baseline = baseResult();
  const result = baseResult({
    run_config: { ...baseline.run_config, personas: [] }
  });
  const interpretation = interpret(baseRecord(), result);

  assert.equal(interpretation.verdict, "no-failure-observed");
  assert.equal(interpretation.coverage, "exercised");
  assert.equal(checkStatus(interpretation, "agent_roster"), "pass");
  assertNoForbiddenInterpretationText(interpretation);
});

test("warn expression invariant fires do not change verdict and report semantics coverage", () => {
  const result = baseResult({
    timeseries: [
      {
        tick: 0,
        active_agents: 2,
        tvl: 100,
        utilization: 0.1,
        derived_observations: { debt_value: 800 }
      },
      {
        tick: 4,
        active_agents: 2,
        tvl: 125,
        utilization: 0.2,
        derived_observations: { debt_value: 800 }
      }
    ],
    summary: {
      expression_invariants: [
        {
          name: "ltv_below_max",
          expr: "debt_value <= max_borrow_value",
          severity: "warn",
          first_tick: 0,
          firing_count: 1,
          observed: [{ tick: 0, values: { debt_value: 800, max_borrow_value: 700 } }]
        }
      ]
    }
  });
  (result as { semantics: unknown }).semantics = {
    class: "lending.v1",
    roles_bound: [{ role_name: "position", source: "instruction.deposit_or_borrow" }],
    derived_observation_definitions: [{ name: "debt_value", expr: "position.debt_amount" }]
  };

  const interpretation = interpret(baseRecord(), result);

  assert.equal(interpretation.verdict, "no-failure-observed");
  assert.equal(checkStatus(interpretation, "semantics_evaluated"), "pass");
  assertNoForbiddenInterpretationText(interpretation);
});

test("error expression invariant fires produce failure-observed verdict", () => {
  const result = baseResult({
    timeseries: [
      {
        tick: 0,
        active_agents: 2,
        tvl: 100,
        utilization: 0.1,
        derived_observations: { debt_value: 800 }
      },
      {
        tick: 4,
        active_agents: 2,
        tvl: 125,
        utilization: 0.2,
        derived_observations: { debt_value: 800 }
      }
    ],
    summary: {
      expression_invariants: [
        {
          name: "ltv_below_max",
          expr: "debt_value <= max_borrow_value",
          severity: "error",
          first_tick: 0,
          firing_count: 1,
          observed: [{ tick: 0, values: { debt_value: 800, max_borrow_value: 700 } }]
        }
      ]
    }
  });
  (result as { semantics: unknown }).semantics = {
    class: "lending.v1",
    roles_bound: [{ role_name: "position", source: "instruction.deposit_or_borrow" }],
    derived_observation_definitions: [{ name: "debt_value", expr: "position.debt_amount" }]
  };

  const interpretation = interpret(baseRecord(), result);

  assert.equal(interpretation.verdict, "failure-observed");
  assert.equal(interpretation.confidence, "high");
  assert.equal(checkStatus(interpretation, "semantics_evaluated"), "pass");
  assert.match(interpretation.evidence.join("\n"), /expression invariant rollup: ltv_below_max fired 1 time at severity error/);
  assertNoForbiddenInterpretationText(interpretation);
});

test("classifies populated summaries with no events and no state delta as inconclusive", () => {
  const result = baseResult({
    events: [],
    timeseries: [
      { tick: 0, active_agents: 2, tvl: 100, utilization: 0.1 },
      { tick: 4, active_agents: 2, tvl: 100, utilization: 0.1 }
    ],
    summary: {
      final_tvl: 100,
      final_utilization: 0.1,
      agents_active: 2,
      agents_liquidated: 0,
      agents_depleted: 0,
      invariants_fired: [
        { name: "no_bad_debt", field: "bad_debt", op: "==", value: 0, firings: 0 }
      ]
    }
  });

  const interpretation = interpret(baseRecord(), result);

  assert.equal(interpretation.verdict, "inconclusive");
  assert.equal(interpretation.coverage, "unexercised");
  assert.equal(interpretation.confidence, "low");
  assert.equal(checkStatus(interpretation, "event_stream"), "fail");
  assert.equal(checkStatus(interpretation, "state_movement"), "fail");
  assertNoForbiddenInterpretationText(interpretation);
});

test("classifies declared-but-missing invariant rows as inconclusive", () => {
  const result = baseResult({
    summary: {
      final_tvl: 125,
      final_utilization: 0.2,
      agents_active: 2,
      agents_liquidated: 0,
      agents_depleted: 0
    }
  });

  const interpretation = interpret(baseRecord(), result, {
    declaredInvariants: ["no_bad_debt", "tvl_floor"]
  });

  assert.equal(interpretation.verdict, "inconclusive");
  assert.equal(interpretation.coverage, "unexercised");
  assert.equal(checkStatus(interpretation, "invariant_inventory"), "fail");
  assertNoForbiddenInterpretationText(interpretation);
});

test("counts semantic expression invariant rows in declared invariant inventory", () => {
  const result = baseResult({
    summary: {
      final_tvl: 125,
      final_utilization: 0.2,
      agents_active: 2,
      agents_liquidated: 0,
      agents_depleted: 0,
      invariants_fired: null,
      expression_invariants: [
        {
          name: "health_factor_above_one",
          expr: "health_factor >= 1",
          severity: "warn",
          first_tick: null,
          firing_count: 0,
          observed: []
        }
      ]
    }
  });

  const interpretation = interpret(baseRecord(), result, {
    declaredInvariants: ["health_factor_above_one"]
  });

  assert.equal(interpretation.verdict, "no-failure-observed");
  assert.equal(checkStatus(interpretation, "invariant_inventory"), "pass");
  assert.equal(
    interpretation.coverage_checks.find((entry) => entry.name === "invariant_inventory")?.detail,
    "1 declared invariant row present"
  );
  assertNoForbiddenInterpretationText(interpretation);
});

test("accepts replay-only aggregate evidence without personas", () => {
  const result = baseResult({
    run_config: {
      agents: 5,
      ticks: 4,
      scenario: "replay:lending-whale-bad-debt",
      seed: 0,
      personas: [],
      validator_url: "http://localhost:8899",
      output_path: ".riptide/replays/lending-whale-bad-debt"
    },
    events: [
      {
        tick: 4,
        agent_id: "otc-liquidator-0",
        persona_id: "otc-liquidator-0",
        persona_label: "otc-liquidator-0",
        action: "liquidate",
        params: { amount: 6400 },
        outcome: "success"
      }
    ],
    agents: [],
    summary: {
      agents_active: 5,
      agents_liquidated: 0,
      agents_depleted: 0,
      invariants_fired: [
        { name: "no_bad_debt", field: "bad_debt", op: "==", value: 0, firings: 0 }
      ]
    }
  });

  const interpretation = interpret(baseRecord({ name: "replay/lending" }), result);

  assert.equal(interpretation.verdict, "no-failure-observed");
  assert.equal(interpretation.coverage, "exercised");
  assert.equal(checkStatus(interpretation, "event_stream"), "pass");
  assert.equal(checkStatus(interpretation, "agent_roster"), "pass");
  assertNoForbiddenInterpretationText(interpretation);
});

test("classifies explained early termination as partial coverage", () => {
  const result = baseResult({
    run_config: {
      agents: 2,
      ticks: 8,
      scenario: "partial",
      seed: 7,
      personas: ["cautious-yield-farmer"],
      validator_url: "http://localhost:8899",
      output_path: ".riptide/runs/partial"
    },
    total_ticks: 3,
    timeseries: [
      { tick: 0, active_agents: 2, tvl: 100 },
      { tick: 3, active_agents: 2, tvl: 110 }
    ]
  });

  const interpretation = interpret(baseRecord({ name: "partial" }), result, {
    earlyTerminationReason: "engine stopped after tick 3"
  });

  assert.equal(interpretation.verdict, "no-failure-observed");
  assert.equal(interpretation.coverage, "partial");
  assert.equal(interpretation.confidence, "low");
  assert.equal(checkStatus(interpretation, "tick_progression"), "warn");
  assertNoForbiddenInterpretationText(interpretation);
});

test("classifies missing SimulationResult or error records as setup error", () => {
  const interpretation = interpret(
    baseRecord({
      status: "error",
      artifacts_dir: undefined,
      error: "adapter failed to parse\nline 2"
    }),
    null
  );

  assert.equal(interpretation.verdict, "setup-error");
  assert.equal(interpretation.coverage, "unknown");
  assert.equal(interpretation.confidence, "none");
  assert.equal(interpretation.severity, "warning");
  assert.equal(checkStatus(interpretation, "tick_progression"), "fail");
  assert.match(interpretation.summary, /Setup failed: adapter failed to parse\./);
  assertNoForbiddenInterpretationText(interpretation);
});
