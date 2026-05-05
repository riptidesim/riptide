// `riptide run` jest-style output formatter + exit code pin tests.
//
// Pins the format contract from format contract. Any
// change to these literals forces a conscious test update — this
// is the CLI output contract CI integrations will depend on from
// here on.
//
// Covers:
// - per-scenario PASS line (ok/✓ + wall-clock + "0 invariant fires")
// - per-scenario FAIL line (FAIL/✗ + count + first-invariant at tick)
// - summary line "<P> pass · <F> fail · <K> skip"
// - per-failure detail block (one line per fire)
// - plain-ASCII fallback driven by NO_COLOR or !isTTY
// - exit codes 0 / 1 / 2 / 3 / 130 matrix
// - `.riptide/last-run.json` shape stable

import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import {
  createJestFormatter,
  firstFireOrNull,
  formatFailureBlock,
  formatNextActionBlock,
  formatScenarioLine,
  formatSummaryLine,
  formatVerdictTotalsLine,
  shouldUsePlainAscii
} from "../src/run/output.js";
import { EXIT_CODES, exitCodeFromSummary } from "../src/run/exit-codes.js";
import type { RunSummary } from "../src/run/loop.js";
import type { ScenarioRecord } from "../src/run/last-run.js";
import type { Coverage, Confidence, RunInterpretation, Severity, Verdict } from "../src/run/interpretation.js";

function interpretation(
  verdict: Verdict,
  opts: Partial<{
    confidence: Confidence;
    coverage: Coverage;
    severity: Severity;
    summary: string;
    next_action: string;
  }> = {}
): RunInterpretation {
  const defaults: Record<Verdict, { confidence: Confidence; coverage: Coverage; severity: Severity; summary: string; next_action: string }> = {
    "failure-observed": {
      confidence: "high",
      coverage: "exercised",
      severity: "critical",
      summary: "Failure observed in this run: 1 invariant fire recorded.",
      next_action: "Review the first invariant fire and inspect simulation artifacts before changing the scenario or adapter."
    },
    "no-failure-observed": {
      confidence: "medium",
      coverage: "exercised",
      severity: "info",
      summary: "No failure observed in this run.",
      next_action: "Review coverage checks and artifacts before using this run as evidence."
    },
    inconclusive: {
      confidence: "low",
      coverage: "unexercised",
      severity: "warning",
      summary: "Scenario inconclusive: coverage checks did not show meaningful scenario exercise.",
      next_action: "Add agent activity, state movement, or invariant inventory, then rerun the scenario."
    },
    "setup-error": {
      confidence: "none",
      coverage: "unknown",
      severity: "warning",
      summary: "Setup failed: engine crashed.",
      next_action: "Fix setup or adapter configuration, then rerun the scenario."
    },
    interrupted: {
      confidence: "none",
      coverage: "unknown",
      severity: "none",
      summary: "Run interrupted: SIGINT received.",
      next_action:
        "No setup or adapter change is implied by this interruption. Rerun when ready, or pass --seeds <N> for a shorter sweep."
    }
  };
  const base = { ...defaults[verdict], ...opts };
  return {
    verdict,
    confidence: base.confidence,
    coverage: base.coverage,
    severity: base.severity,
    summary: base.summary,
    next_action: base.next_action,
    evidence: [],
    reasons: [],
    coverage_checks: []
  };
}

// --- Per-scenario line format ---

test("formatScenarioLine: PASS includes no-failure verdict, confidence, and coverage", () => {
  const line = formatScenarioLine(
    {
      name: "baseline",
      run_config_path: "/x",
      status: "pass",
      wall_clock_s: 0.4,
      invariant_fires: [],
      interpretation: interpretation("no-failure-observed")
    },
    "✓",
    "✗"
  );
  // Two-space gap is deliberate (mirrors jest's typography). Don't
  // collapse to a single space or the pin test catches it.
  assert.equal(
    line,
    "✓ baseline  (0.4s, no failure observed, confidence: medium, coverage: exercised)"
  );
});

test("formatScenarioLine: FAIL includes failure verdict, confidence, coverage, and first fire", () => {
  const line = formatScenarioLine(
    {
      name: "hero-grid/w25-s40",
      run_config_path: "/x",
      status: "fail",
      wall_clock_s: 1.2,
      invariant_fires: [{ name: "no_bad_debt", tick: 7 }],
      interpretation: interpretation("failure-observed")
    },
    "✓",
    "✗"
  );
  assert.equal(
    line,
    "✗ hero-grid/w25-s40  (1.2s, failure observed, confidence: high, coverage: exercised, 1 invariant fire: no_bad_debt at tick 7)"
  );
});

test("formatScenarioLine: FAIL with N>1 fires uses plural 'invariant fires' + names first only", () => {
  const line = formatScenarioLine(
    {
      name: "smoke",
      run_config_path: "/x",
      status: "fail",
      wall_clock_s: 2.0,
      invariant_fires: [
        { name: "first_inv", tick: 3 },
        { name: "second_inv", tick: 9 }
      ],
      interpretation: interpretation("failure-observed")
    },
    "✓",
    "✗"
  );
  assert.equal(
    line,
    "✗ smoke  (2.0s, failure observed, confidence: high, coverage: exercised, 2 invariant fires: first_inv at tick 3)"
  );
});

test("formatScenarioLine: inconclusive uses ? glyph and coverage", () => {
  const line = formatScenarioLine(
    {
      name: "weak",
      run_config_path: "/x",
      status: "pass",
      wall_clock_s: 0.2,
      invariant_fires: [],
      interpretation: interpretation("inconclusive")
    },
    "✓",
    "✗",
    "!",
    "?"
  );
  assert.equal(
    line,
    "? weak  (0.2s, inconclusive, confidence: low, coverage: unexercised)"
  );
});

test("formatScenarioLine: plain-ASCII glyphs replace ✓ / ✗ with ok / FAIL", () => {
  const pass = formatScenarioLine(
    {
      name: "a",
      run_config_path: "/x",
      status: "pass",
      wall_clock_s: 0.1,
      invariant_fires: [],
      interpretation: interpretation("no-failure-observed")
    },
    "ok",
    "FAIL"
  );
  assert.equal(pass, "ok a  (0.1s, no failure observed, confidence: medium, coverage: exercised)");
  const fail = formatScenarioLine(
    {
      name: "b",
      run_config_path: "/x",
      status: "fail",
      wall_clock_s: 0.1,
      invariant_fires: [{ name: "inv", tick: 1 }],
      interpretation: interpretation("failure-observed")
    },
    "ok",
    "FAIL"
  );
  assert.equal(
    fail,
    "FAIL b  (0.1s, failure observed, confidence: high, coverage: exercised, 1 invariant fire: inv at tick 1)"
  );
});

test("formatScenarioLine: setup-error line names the first line of the error message", () => {
  const line = formatScenarioLine(
    {
      name: "c",
      run_config_path: "/x",
      status: "error",
      wall_clock_s: 0,
      invariant_fires: [],
      error: "engine crashed\nmore detail",
      interpretation: interpretation("setup-error")
    },
    "✓",
    "✗",
    "!"
  );
  assert.equal(
    line,
    "! c  (0.0s, setup failed: engine crashed, confidence: none, coverage: unknown)"
  );
});

test("formatScenarioLine: interrupted line does not blame setup or adapter config", () => {
  const line = formatScenarioLine(
    {
      name: "baseline",
      run_config_path: "/x",
      status: "error",
      wall_clock_s: 12,
      invariant_fires: [],
      error: "riptide-engine terminated by signal SIGINT",
      interpretation: interpretation("interrupted")
    },
    "ok",
    "FAIL",
    "ERROR"
  );
  assert.equal(
    line,
    "ERROR baseline  (12.0s, interrupted: riptide-engine terminated by signal SIGINT, confidence: none, coverage: unknown)"
  );
});

test("formatScenarioLine: skipped line prints a muted placeholder", () => {
  const line = formatScenarioLine(
    {
      name: "d",
      run_config_path: "/x",
      status: "skipped",
      wall_clock_s: 0,
      invariant_fires: [],
      error: "skipped: SIGINT received before scenario could start"
    },
    "✓",
    "✗",
    "!"
  );
  assert.equal(
    line,
    "- d  (skipped: skipped: SIGINT received before scenario could start)"
  );
});

// --- Summary line format ---

test("formatSummaryLine: exact shape '<P> pass · <F> fail · <E> error · <K> skip'", () => {
  const summary: RunSummary = {
    pass: 3,
    fail: 1,
    error: 0,
    skipped: 2,
    total: 6,
    signalAborted: false,
    partialAbort: false,
    lastRunPath: "/x",
    runCollectionPath: "/x-collection",
    scenarios: []
  };
  assert.equal(formatSummaryLine(summary), "3 pass · 1 fail · 0 error · 2 skip");
});

test("formatSummaryLine: errors counted separately from skip (error classifier expansion)", () => {
  const summary: RunSummary = {
    pass: 1,
    fail: 0,
    error: 2,
    skipped: 0,
    total: 3,
    signalAborted: false,
    partialAbort: true,
    lastRunPath: "/x",
    runCollectionPath: "/x-collection",
    scenarios: []
  };
  assert.equal(formatSummaryLine(summary), "1 pass · 0 fail · 2 error · 0 skip");
});

test("formatSummaryLine: SIGINT-aborted runs are explicitly marked interrupted", () => {
  const summary: RunSummary = {
    pass: 0,
    fail: 0,
    error: 1,
    skipped: 0,
    total: 1,
    signalAborted: true,
    partialAbort: false,
    lastRunPath: "/x",
    runCollectionPath: "/x-collection",
    scenarios: []
  };
  assert.equal(formatSummaryLine(summary), "0 pass · 0 fail · 1 error · 0 skip · interrupted");
});

test("formatVerdictTotalsLine: counts interpretation verdicts", () => {
  const summary: RunSummary = {
    pass: 1,
    fail: 1,
    error: 2,
    skipped: 0,
    total: 3,
    signalAborted: false,
    partialAbort: true,
    lastRunPath: "/x",
    runCollectionPath: "/x-collection",
    scenarios: [
      {
        name: "a",
        run_config_path: "/a",
        status: "pass",
        wall_clock_s: 0.1,
        invariant_fires: [],
        interpretation: interpretation("no-failure-observed")
      },
      {
        name: "b",
        run_config_path: "/b",
        status: "fail",
        wall_clock_s: 0.2,
        invariant_fires: [{ name: "inv", tick: 1 }],
        interpretation: interpretation("failure-observed")
      },
      {
        name: "c",
        run_config_path: "/c",
        status: "error",
        wall_clock_s: 0,
        invariant_fires: [],
        interpretation: interpretation("setup-error")
      },
      {
        name: "stopped",
        run_config_path: "/stopped",
        status: "error",
        wall_clock_s: 3,
        invariant_fires: [],
        interpretation: interpretation("interrupted")
      }
    ]
  };
  assert.equal(
    formatVerdictTotalsLine(summary),
    "verdicts: 1 failure-observed · 1 no-failure-observed · 1 setup-error · 1 interrupted"
  );
});

// --- Per-failure detail block ---

test("formatFailureBlock: one indented bullet per fire, each naming inv + tick", () => {
  const record: ScenarioRecord = {
    name: "x",
    run_config_path: "/x",
    status: "fail",
    wall_clock_s: 0.3,
    invariant_fires: [
      { name: "inv_a", tick: 2 },
      { name: "inv_b", tick: 5 }
    ]
  };
  const block = formatFailureBlock(record, "✗");
  assert.equal(
    block,
    ["  ✗ x", "    - inv_a at tick 2", "    - inv_b at tick 5"].join("\n")
  );
});

test("formatFailureBlock: error record uses the error glyph + 'error:' prefix", () => {
  const record: ScenarioRecord = {
    name: "y",
    run_config_path: "/x",
    status: "error",
    wall_clock_s: 0,
    invariant_fires: [],
    error: "engine crashed"
  };
  const block = formatFailureBlock(record, "✗", "!");
  assert.equal(block, ["  ! y", "    - error: engine crashed"].join("\n"));
});

test("formatNextActionBlock: appears for failure, inconclusive, setup-error, and interrupted records", () => {
  const summary: RunSummary = {
    pass: 1,
    fail: 1,
    error: 2,
    skipped: 0,
    total: 3,
    signalAborted: false,
    partialAbort: true,
    lastRunPath: "/repo/.riptide/last-run.json",
    runCollectionPath: "/repo/.riptide/run-collection.json",
    scenarios: [
      {
        name: "clean",
        run_config_path: "/clean",
        status: "pass",
        wall_clock_s: 0.1,
        invariant_fires: [],
        interpretation: interpretation("no-failure-observed")
      },
      {
        name: "weak",
        run_config_path: "/weak",
        status: "pass",
        wall_clock_s: 0.1,
        invariant_fires: [],
        artifacts_dir: ".riptide/runs/weak",
        interpretation: interpretation("inconclusive")
      },
      {
        name: "broken",
        run_config_path: "/broken",
        status: "error",
        wall_clock_s: 0,
        invariant_fires: [],
        interpretation: interpretation("setup-error")
      },
      {
        name: "stopped",
        run_config_path: "/stopped",
        status: "error",
        wall_clock_s: 0,
        invariant_fires: [],
        interpretation: interpretation("interrupted")
      }
    ]
  };

  const block = formatNextActionBlock(summary);
  assert.ok(block);
  assert.match(block!, /weak: Add agent activity/);
  assert.match(block!, /Inspect \.riptide\/runs\/weak\./);
  assert.match(block!, /broken: Fix setup or adapter configuration/);
  assert.match(block!, /stopped: No setup or adapter change is implied/);
  assert.match(block!, /Inspect \/repo\/\.riptide\/run-collection\.json\./);
  assert.equal(block!.includes("clean:"), false);
});

test("formatNextActionBlock: omitted for clean no-failure runs", () => {
  const summary: RunSummary = {
    pass: 1,
    fail: 0,
    error: 0,
    skipped: 0,
    total: 1,
    signalAborted: false,
    partialAbort: false,
    lastRunPath: "/x",
    runCollectionPath: "/x-collection",
    scenarios: [
      {
        name: "clean",
        run_config_path: "/clean",
        status: "pass",
        wall_clock_s: 0.1,
        invariant_fires: [],
        interpretation: interpretation("no-failure-observed")
      }
    ]
  };
  assert.equal(formatNextActionBlock(summary), null);
});

// --- Plain-ASCII detection ---

test("shouldUsePlainAscii: NO_COLOR set → true regardless of TTY", () => {
  assert.equal(shouldUsePlainAscii({ NO_COLOR: "1" }, true), true);
  assert.equal(shouldUsePlainAscii({ NO_COLOR: "" }, true), false);
});

test("shouldUsePlainAscii: !isTTY → true", () => {
  assert.equal(shouldUsePlainAscii({}, false), true);
  assert.equal(shouldUsePlainAscii({}, true), false);
});

// --- Formatter event integration ---

test("createJestFormatter: emits per-scenario line on scenario_end, summary on run_end", () => {
  const stdout = new PassThrough();
  stdout.setEncoding("utf8");
  let buf = "";
  stdout.on("data", (c: string) => {
    buf += c;
  });

  const fmt = createJestFormatter({ stdout, stderr: new PassThrough(), plainAscii: true, color: false });
  fmt.handle({ type: "run_start", total: 2, cwd: "/x" });
  fmt.handle({
    type: "scenario_end",
    index: 0,
    total: 2,
    scenario: { name: "alpha", runConfigPath: "/a" },
    record: {
      name: "alpha",
      run_config_path: "/a",
      status: "pass",
      wall_clock_s: 0.1,
      invariant_fires: [],
      interpretation: interpretation("no-failure-observed")
    }
  });
  fmt.handle({
    type: "scenario_end",
    index: 1,
    total: 2,
    scenario: { name: "bravo", runConfigPath: "/b" },
    record: {
      name: "bravo",
      run_config_path: "/b",
      status: "fail",
      wall_clock_s: 0.2,
      invariant_fires: [{ name: "inv", tick: 1 }],
      artifacts_dir: ".riptide/runs/bravo",
      interpretation: interpretation("failure-observed")
    }
  });
  fmt.handle({
    type: "run_end",
    summary: {
      pass: 1,
      fail: 1,
      error: 0,
      skipped: 0,
      total: 2,
      signalAborted: false,
      partialAbort: false,
      lastRunPath: "/x",
      runCollectionPath: "/x-collection",
      scenarios: [
        {
          name: "alpha",
          run_config_path: "/a",
          status: "pass",
          wall_clock_s: 0.1,
          invariant_fires: [],
          interpretation: interpretation("no-failure-observed")
        },
        {
          name: "bravo",
          run_config_path: "/b",
          status: "fail",
          wall_clock_s: 0.2,
          invariant_fires: [{ name: "inv", tick: 1 }],
          artifacts_dir: ".riptide/runs/bravo",
          interpretation: interpretation("failure-observed")
        }
      ]
    }
  });

  const lines = buf.split("\n");
  // per-scenario lines
  assert.equal(lines[0], "ok alpha  (0.1s, no failure observed, confidence: medium, coverage: exercised)");
  assert.equal(
    lines[1],
    "FAIL bravo  (0.2s, failure observed, confidence: high, coverage: exercised, 1 invariant fire: inv at tick 1)"
  );
  // blank separator, then summary + verdict totals, then failure block + next action
  assert.equal(lines[2], "");
  assert.equal(lines[3], "1 pass · 1 fail · 0 error · 0 skip");
  assert.equal(lines[4], "verdicts: 1 failure-observed · 1 no-failure-observed");
  assert.equal(lines[5], "");
  assert.equal(lines[6], "  FAIL bravo");
  assert.equal(lines[7], "    - inv at tick 1");
  assert.equal(lines[8], "");
  assert.equal(lines[9], "Next action:");
  assert.equal(
    lines[10],
    "  - bravo: Review the first invariant fire and inspect simulation artifacts before changing the scenario or adapter. Inspect .riptide/runs/bravo."
  );
});

test("createJestFormatter: emits sweep progress while long seed sweeps are running", () => {
  const stdout = new PassThrough();
  stdout.setEncoding("utf8");
  let buf = "";
  stdout.on("data", (c: string) => {
    buf += c;
  });

  const fmt = createJestFormatter({
    stdout,
    stderr: new PassThrough(),
    plainAscii: true,
    color: false
  });

  const scenario = { name: "baseline", runConfigPath: "/x/run-config.json" };
  fmt.handle({
    type: "sweep_start",
    scenario,
    sweepSize: 50,
    seedRoot: 1234,
    parallelism: 8,
    failFast: true,
    agents: 1000,
    ticks: 30,
    eventsPerCell: 30000,
    totalEvents: 1500000
  });
  fmt.handle({
    type: "sweep_progress",
    scenario,
    sweepSize: 50,
    seedRoot: 1234,
    parallelism: 8,
    started: 8,
    active: 8,
    completed: 0,
    passed: 0,
    fired: 0,
    engineErrors: 0,
    killed: 0,
    elapsedS: 30,
    oldestActiveS: 30,
    eventsPerCell: 30000,
    totalEvents: 1500000
  });
  fmt.handle({
    type: "sweep_end",
    scenario,
    sweepSize: 50,
    seedRoot: 1234,
    completed: 50,
    fired: 0,
    engineErrors: 0,
    status: "all_pass",
    wallClockS: 2100
  });

  const lines = buf.trimEnd().split("\n");
  assert.equal(
    lines[0],
    "sweep baseline: 50 seeds from 1234 (8 parallel, 1000 agents x 30 ticks = 30,000 events/seed, 1,500,000 planned events, fail-fast)"
  );
  assert.equal(
    lines[1],
    "  progress baseline: 0/50 complete, 8 active for 30.0s, 8 started, 0 pass, 0 fired, 0 error, elapsed 30.0s; first seed still running (30,000 events/seed)"
  );
  assert.equal(lines[2], "sweep baseline: all_pass, 50/50 complete in 35m 00s");
});

test("createJestFormatter: dashboard URL echoed only when provided", () => {
  const stdout = new PassThrough();
  stdout.setEncoding("utf8");
  let buf = "";
  stdout.on("data", (c: string) => {
    buf += c;
  });

  const fmt = createJestFormatter({
    stdout,
    stderr: new PassThrough(),
    plainAscii: true,
    color: false,
    dashboardUrl: "http://localhost:4173"
  });
  fmt.handle({
    type: "run_end",
    summary: {
      pass: 1,
      fail: 0,
      error: 0,
      skipped: 0,
      total: 1,
      signalAborted: false,
      partialAbort: false,
      lastRunPath: "/x",
      runCollectionPath: "/x-collection",
      scenarios: [
        {
          name: "a",
          run_config_path: "/x",
          status: "pass",
          wall_clock_s: 0.1,
          invariant_fires: []
        }
      ]
    }
  });

  assert.ok(buf.includes("Dashboard: http://localhost:4173"));
});

// --- Exit code matrix ---

test("exit code: 0 when all scenarios passed and no abort", () => {
  const summary: RunSummary = {
    pass: 3,
    fail: 0,
    error: 0,
    skipped: 0,
    total: 3,
    signalAborted: false,
    partialAbort: false,
    lastRunPath: "/x",
    runCollectionPath: "/x-collection",
    scenarios: []
  };
  assert.equal(exitCodeFromSummary(summary), EXIT_CODES.SUCCESS);
  assert.equal(EXIT_CODES.SUCCESS, 0);
});

test("exit code: 1 when at least one invariant fired", () => {
  const summary: RunSummary = {
    pass: 2,
    fail: 1,
    error: 0,
    skipped: 0,
    total: 3,
    signalAborted: false,
    partialAbort: false,
    lastRunPath: "/x",
    runCollectionPath: "/x-collection",
    scenarios: []
  };
  assert.equal(exitCodeFromSummary(summary), EXIT_CODES.INVARIANT_FIRE);
  assert.equal(EXIT_CODES.INVARIANT_FIRE, 1);
});

test("exit code: 2 when one or more scenarios errored (error reclassification)", () => {
  const summary: RunSummary = {
    pass: 1,
    fail: 0,
    error: 1,
    skipped: 0,
    total: 2,
    signalAborted: false,
    partialAbort: true,
    lastRunPath: "/x",
    runCollectionPath: "/x-collection",
    scenarios: []
  };
  assert.equal(exitCodeFromSummary(summary), EXIT_CODES.SETUP_ERROR);
  assert.equal(EXIT_CODES.SETUP_ERROR, 2);
});

test("exit code: 130 on SIGINT (Unix convention, wins over fail/abort)", () => {
  const summary: RunSummary = {
    pass: 0,
    fail: 1,
    error: 1,
    skipped: 1,
    total: 3,
    signalAborted: true,
    partialAbort: false,
    lastRunPath: "/x",
    runCollectionPath: "/x-collection",
    scenarios: []
  };
  assert.equal(exitCodeFromSummary(summary), EXIT_CODES.SIGINT);
  assert.equal(EXIT_CODES.SIGINT, 130);
});

test("EXIT_CODES constants are frozen at 0 / 1 / 2 / 3 / 130", () => {
  assert.equal(EXIT_CODES.SUCCESS, 0);
  assert.equal(EXIT_CODES.INVARIANT_FIRE, 1);
  assert.equal(EXIT_CODES.SETUP_ERROR, 2);
  assert.equal(EXIT_CODES.PARTIAL_ABORT, 3);
  assert.equal(EXIT_CODES.SIGINT, 130);
});

// --- R10 hygiene: colors, path relativization, engine stderr de-dup ---

test("createJestFormatter: color=true wraps the pass line in green ANSI", () => {
  const stdout = new PassThrough();
  stdout.setEncoding("utf8");
  let buf = "";
  stdout.on("data", (c: string) => {
    buf += c;
  });

  const fmt = createJestFormatter({
    stdout,
    stderr: new PassThrough(),
    plainAscii: true,
    color: true
  });
  fmt.handle({
    type: "scenario_end",
    index: 0,
    total: 1,
    scenario: { name: "alpha", runConfigPath: "/a" },
    record: {
      name: "alpha",
      run_config_path: "/a",
      status: "pass",
      wall_clock_s: 0.1,
      invariant_fires: []
    }
  });

  // ANSI 32 is green; trailing reset is \x1b[0m.
  assert.match(buf, /\x1b\[32m.*ok alpha.*\x1b\[0m/);
});

test("createJestFormatter: color=false emits NO escape codes (NO_COLOR path)", () => {
  const stdout = new PassThrough();
  stdout.setEncoding("utf8");
  let buf = "";
  stdout.on("data", (c: string) => {
    buf += c;
  });

  const fmt = createJestFormatter({
    stdout,
    stderr: new PassThrough(),
    plainAscii: true,
    color: false
  });
  fmt.handle({
    type: "scenario_end",
    index: 0,
    total: 1,
    scenario: { name: "x", runConfigPath: "/a" },
    record: {
      name: "x",
      run_config_path: "/a",
      status: "pass",
      wall_clock_s: 0.1,
      invariant_fires: []
    }
  });
  fmt.handle({
    type: "run_end",
    summary: {
      pass: 1,
      fail: 0,
      error: 0,
      skipped: 0,
      total: 1,
      signalAborted: false,
      partialAbort: false,
      lastRunPath: "/x",
      runCollectionPath: "/x-collection",
      scenarios: [
        {
          name: "x",
          run_config_path: "/a",
          status: "pass",
          wall_clock_s: 0.1,
          invariant_fires: []
        }
      ]
    }
  });
  // No escape codes anywhere in the output.
  assert.equal(buf.includes("\x1b["), false, "expected plain ASCII output under color=false");
});

test("createJestFormatter: engine stderr rendered once in the failure block (no duplication)", () => {
  const stdout = new PassThrough();
  stdout.setEncoding("utf8");
  let buf = "";
  stdout.on("data", (c: string) => {
    buf += c;
  });

  const fmt = createJestFormatter({
    stdout,
    stderr: new PassThrough(),
    plainAscii: true,
    color: false
  });
  const record = {
    name: "broken",
    run_config_path: "/b",
    status: "error" as const,
    wall_clock_s: 0,
    invariant_fires: [],
    error: "engine exited 2",
    engine_stderr: "line-a\nline-b\n"
  };
  fmt.handle({
    type: "scenario_end",
    index: 0,
    total: 1,
    scenario: { name: "broken", runConfigPath: "/b" },
    record
  });
  fmt.handle({
    type: "run_end",
    summary: {
      pass: 0,
      fail: 0,
      error: 1,
      skipped: 0,
      total: 1,
      signalAborted: false,
      partialAbort: true,
      lastRunPath: "/x",
      runCollectionPath: "/x-collection",
      scenarios: [record]
    }
  });

  // Engine stderr lines appear exactly once (in the failure block),
  // not twice (no inline pass-through duplication).
  const aMatches = (buf.match(/line-a/g) ?? []).length;
  const bMatches = (buf.match(/line-b/g) ?? []).length;
  assert.equal(aMatches, 1, "engine stderr line 'line-a' should appear exactly once");
  assert.equal(bMatches, 1, "engine stderr line 'line-b' should appear exactly once");
});

test("createJestFormatter: absolute paths inside cwd are rewritten relative in scenario line", () => {
  const stdout = new PassThrough();
  stdout.setEncoding("utf8");
  let buf = "";
  stdout.on("data", (c: string) => {
    buf += c;
  });

  const fmt = createJestFormatter({
    stdout,
    stderr: new PassThrough(),
    plainAscii: true,
    color: false,
    cwd: "/home/u/repo"
  });
  fmt.handle({
    type: "scenario_end",
    index: 0,
    total: 1,
    scenario: { name: "b", runConfigPath: "/home/u/repo/.riptide/scenarios/b/run-config.json" },
    record: {
      name: "b",
      run_config_path: "/home/u/repo/.riptide/scenarios/b/run-config.json",
      status: "error",
      wall_clock_s: 0,
      invariant_fires: [],
      error: "adapter not found at /home/u/repo/fixtures/adapters/missing.toml"
    }
  });
  // Absolute path inside cwd → relative. Absolute path OUTSIDE cwd
  // would have been preserved — not asserted here since the record
  // doesn't carry one.
  assert.ok(
    buf.includes("fixtures/adapters/missing.toml"),
    `expected relativized path in output: ${buf}`
  );
  assert.equal(
    buf.includes("/home/u/repo/fixtures"),
    false,
    "absolute path should not appear after relativization"
  );
});

// --- Helpers ---

test("firstFireOrNull: returns first element or null", () => {
  assert.equal(firstFireOrNull([]), null);
  assert.deepEqual(firstFireOrNull([{ name: "a", tick: 1 }]), { name: "a", tick: 1 });
});
