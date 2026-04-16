import chalk from "chalk";
import Table from "cli-table3";

import type { SimulationResult } from "../compiler/schema.js";

// Both `summary` and `timeseries[i]` are primitive-agnostic key/value
// maps. Lending runs still emit their historical keys; generic runs
// emit adapter-declared observation aggregates with no lending shape
// at all. The renderer displays known lending keys with their current
// labels and falls back to a generic `key: value` table for anything
// else.

type SummaryCell = number | boolean | string | null;

// Defense-in-depth against ANSI injection via adapter-supplied
// identifiers. The engine-side loader
// and the CLI-side adapter schema both reject identifiers containing
// control characters, but the renderer is the last line of output
// — if an adapter ever slips past validation the renderer must not
// emit raw control bytes to the operator's terminal. Sanitize every
// key and every string value at render time as a belt-and-suspenders.
const SAFE_KEY_RE = /^[A-Za-z0-9_.-]+$/;

function sanitizeKey(key: string): string {
  if (SAFE_KEY_RE.test(key) && key.length <= 128) {
    return key;
  }
  // Drop the key down to the allow-list charset plus a visible marker
  // so an operator who sees it knows it was rewritten. Truncate long
  // keys so a single malicious entry can't flood the summary view.
  const filtered = key
    .replace(/[^A-Za-z0-9_.-]/g, "?")
    .slice(0, 128);
  return `${filtered} (sanitized)`;
}

function sanitizeStringCell(value: string): string {
  // Strip C0/C1 controls + DEL. Keep everything else so legitimate
  // UTF-8 text still renders, and cap the length.
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) {
      out += "?";
    } else {
      out += char;
    }
    if (out.length >= 256) {
      out += "…";
      break;
    }
  }
  return out;
}

const LENDING_KEY_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["final_tvl", "Final TVL"],
  ["final_utilization", "Final Utilization"],
  ["total_liquidations", "Liquidations"],
  ["total_bad_debt", "Bad Debt"],
  ["largest_single_tick_drawdown", "Largest Drawdown"]
];

const LIFECYCLE_KEYS: ReadonlySet<string> = new Set([
  "agents_active",
  "agents_liquidated",
  "agents_depleted"
]);

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function formatCell(value: SummaryCell): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    // Integer-looking numbers render without trailing decimals; floats
    // render with 4-digit precision.
    return Number.isInteger(value) ? value.toString() : value.toFixed(4);
  }
  if (typeof value === "string") {
    return sanitizeStringCell(value);
  }
  return String(value);
}

export function renderSummary(result: SimulationResult): string {
  const { run_config, summary } = result;
  const lines: string[] = [
    chalk.bold("Riptide Simulation Summary"),
    `Scenario: ${run_config.scenario}`,
    `Agents: ${run_config.agents} | Ticks: ${result.total_ticks} | Seed: ${result.seed}`
  ];

  // Lending-shaped keys: if any of the historical lending keys are
  // present, render them with their familiar labels and the canonical
  // lending coloring heuristics.
  const hasLending = LENDING_KEY_LABELS.some(([key]) => key in summary);
  if (hasLending) {
    const utilization = toNumber((summary as Record<string, unknown>).final_utilization);
    const utilizationColor =
      utilization !== undefined && utilization >= 0.85 ? chalk.red : chalk.green;
    const badDebt = toNumber((summary as Record<string, unknown>).total_bad_debt);
    const debtColor = badDebt !== undefined && badDebt > 0 ? chalk.red : chalk.green;

    for (const [key, label] of LENDING_KEY_LABELS) {
      if (!(key in summary)) continue;
      const cell = (summary as Record<string, SummaryCell>)[key];
      let formatted = formatCell(cell);
      if (key === "final_tvl" && typeof cell === "number") {
        formatted = chalk.green(cell.toFixed(2));
      }
      if (key === "final_utilization" && utilization !== undefined) {
        formatted = utilizationColor(utilization.toFixed(2));
      }
      if (key === "total_bad_debt" && badDebt !== undefined) {
        formatted = debtColor(badDebt.toFixed(2));
      }
      lines.push(`${label}: ${formatted}`);
    }
  }

  // Lifecycle counters are domain-neutral and always shown.
  const lifecyclePieces: string[] = [];
  for (const key of LIFECYCLE_KEYS) {
    if (key in summary) {
      const cell = (summary as Record<string, SummaryCell>)[key];
      lifecyclePieces.push(`${key.replace("agents_", "")}=${formatCell(cell)}`);
    }
  }
  if (lifecyclePieces.length > 0) {
    lines.push(`Agent Status Counts: ${lifecyclePieces.join(", ")}`);
  }

  // Any keys we didn't already render (adapter-declared observation
  // aggregates for generic runs, or lending keys we didn't special-case)
  // fall back to a sorted `key: value` table. Sorted so the output is
  // byte-stable regardless of enumeration order.
  const handled = new Set<string>([
    ...LENDING_KEY_LABELS.map(([key]) => key),
    ...LIFECYCLE_KEYS
  ]);
  const extraKeys = Object.keys(summary)
    .filter((key) => !handled.has(key))
    .sort();
  if (extraKeys.length > 0) {
    lines.push(hasLending ? chalk.bold("Observations:") : chalk.bold("Metrics:"));
    for (const key of extraKeys) {
      const cell = (summary as Record<string, SummaryCell>)[key];
      lines.push(`  ${sanitizeKey(key)}: ${formatCell(cell)}`);
    }
  }

  lines.push("Simulation Boundaries:");
  for (const boundary of result.simulation_boundaries) {
    lines.push(`- ${sanitizeStringCell(boundary)}`);
  }
  return lines.join("\n");
}

/**
 * Renders a colored bordered table for TTY output (T15).
 * Same data as renderSummary but in a visual table format.
 */
export function renderColoredTable(result: SimulationResult): string {
  const { run_config, summary } = result;
  const summaryRecord = summary as Record<string, SummaryCell>;

  const header = [
    chalk.bold("Riptide Simulation Summary"),
    `Scenario: ${run_config.scenario} | Agents: ${run_config.agents} | Ticks: ${result.total_ticks} | Seed: ${result.seed}`
  ].join("\n");

  const table = new Table({
    head: [chalk.bold("Metric"), chalk.bold("Value")],
    style: { head: [], border: [] }
  });

  // Lending-shaped keys with color heuristics
  const hasLending = LENDING_KEY_LABELS.some(([key]) => key in summaryRecord);
  if (hasLending) {
    const utilization = toNumber(summaryRecord.final_utilization);
    const badDebt = toNumber(summaryRecord.total_bad_debt);

    for (const [key, label] of LENDING_KEY_LABELS) {
      if (!(key in summaryRecord)) continue;
      const cell = summaryRecord[key];
      let formatted = formatCell(cell);
      if (key === "final_utilization" && utilization !== undefined) {
        formatted = utilization >= 0.85
          ? chalk.red(utilization.toFixed(2))
          : chalk.green(utilization.toFixed(2));
      } else if (key === "total_bad_debt" && badDebt !== undefined) {
        formatted = badDebt > 0
          ? chalk.red(badDebt.toFixed(2))
          : chalk.green(badDebt.toFixed(2));
      } else if (key === "total_liquidations") {
        const liq = toNumber(cell);
        formatted = liq !== undefined && liq > 0
          ? chalk.yellow(liq.toString())
          : chalk.green(formatCell(cell));
      } else if (typeof cell === "number") {
        formatted = chalk.green(formatCell(cell));
      }
      table.push([label, formatted]);
    }
  }

  // Lifecycle counters
  for (const key of LIFECYCLE_KEYS) {
    if (key in summaryRecord) {
      const cell = summaryRecord[key];
      const label = key.replace("agents_", "Agents ");
      const val = toNumber(cell);
      let formatted = formatCell(cell);
      if (key === "agents_liquidated" && val !== undefined && val > 0) {
        formatted = chalk.red(formatted);
      } else if (key === "agents_depleted" && val !== undefined && val > 0) {
        formatted = chalk.yellow(formatted);
      } else {
        formatted = chalk.green(formatted);
      }
      table.push([label, formatted]);
    }
  }

  // Generic / extra keys
  const handled = new Set<string>([
    ...LENDING_KEY_LABELS.map(([key]) => key),
    ...LIFECYCLE_KEYS
  ]);
  const extraKeys = Object.keys(summaryRecord)
    .filter((key) => !handled.has(key))
    .sort();
  for (const key of extraKeys) {
    const cell = summaryRecord[key];
    table.push([sanitizeKey(key), formatCell(cell)]);
  }

  // Invariant violations in events
  const invariantEvents = result.events.filter(
    (e) => e.agent_id === "__engine__" && e.action.startsWith("invariant_violation:")
  );
  if (invariantEvents.length > 0) {
    const names = new Set(invariantEvents.map((e) => e.action.slice("invariant_violation:".length)));
    table.push([
      chalk.yellow("Invariant violations"),
      chalk.yellow(`${invariantEvents.length} (${[...names].join(", ")})`)
    ]);
  }

  return `${header}\n${table.toString()}`;
}
