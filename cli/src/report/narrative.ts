import type { SimulationResult } from "../compiler/schema.js";
import { formatProgramError } from "./events.js";

/**
 * Renders a markdown narrative report from a simulation result.
 * Primitive-agnostic: iterates over whatever keys the summary contains.
 */

type SummaryValue = number | boolean | string | null;

const LIFECYCLE_KEYS = new Set(["agents_active", "agents_liquidated", "agents_depleted"]);
const STRUCTURED_SUMMARY_KEYS = new Set(["invariants_fired", "expression_invariants"]);

function formatValue(value: SummaryValue): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    return Number.isInteger(value) ? value.toString() : value.toFixed(4);
  }
  return String(value);
}

function personaBreakdown(result: SimulationResult): string {
  const counts = new Map<string, number>();
  for (const agent of result.agents) {
    counts.set(agent.persona_label, (counts.get(agent.persona_label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([label, count]) => `${count}× ${label}`)
    .join(", ");
}

interface InvariantRow {
  name: string;
  firings: number;
  firstTick: number;
}

function extractInvariants(result: SimulationResult): InvariantRow[] {
  const map = new Map<string, { firings: number; firstTick: number }>();
  for (const event of result.events) {
    if (event.agent_id === "__engine__" && event.action.startsWith("invariant_violation:")) {
      const name = event.action.slice("invariant_violation:".length);
      const existing = map.get(name);
      if (existing) {
        existing.firings++;
      } else {
        map.set(name, { firings: 1, firstTick: event.tick });
      }
    }
  }
  return [...map.entries()].map(([name, { firings, firstTick }]) => ({
    name,
    firings,
    firstTick
  }));
}

interface NotableEvent {
  tick: number;
  description: string;
}

const NOTABLE_ACTIONS = new Set([
  "liquidate", "liquidate_position",
  "trigger_activated",
  "scheduled_action"
]);

function isNotableEvent(event: { action: string; outcome: string; agent_id: string }): boolean {
  if (event.agent_id === "__engine__") return true;
  if (NOTABLE_ACTIONS.has(event.action)) return true;
  if (event.outcome === "failed") return true;
  return false;
}

function extractNotableEvents(result: SimulationResult, maxEvents = 10): NotableEvent[] {
  const notable: NotableEvent[] = [];
  for (const event of result.events) {
    if (!isNotableEvent(event)) continue;
    const who = event.agent_id === "__engine__" ? "Engine" : `${event.persona_label ?? "Unknown"} (${event.agent_id})`;
    const programError = formatProgramError(event);
    const detail = programError ? ` — ${programError}` : "";
    notable.push({
      tick: event.tick,
      description: `T${event.tick}: ${who} — ${event.action} → ${event.outcome}${detail}`
    });
  }
  return notable.slice(0, maxEvents);
}

export interface NarrativeConfig {
  adapterPath: string;
  /** The CLI command that would reproduce this run. */
  reproCommand?: string;
}

export function renderNarrative(
  result: SimulationResult,
  config: NarrativeConfig
): string {
  const { run_config } = result;
  const lines: string[] = [];

  // Title
  lines.push("# Riptide Simulation Report");
  lines.push("");

  // Run metadata
  lines.push("## Run metadata");
  lines.push("");
  lines.push(`- **Adapter**: \`${config.adapterPath}\``);
  lines.push(`- **Seed**: ${result.seed}`);
  lines.push(`- **Ticks**: ${result.total_ticks}`);
  lines.push(`- **Agents**: ${run_config.agents} (${personaBreakdown(result)})`);
  lines.push(`- **Scenario**: ${run_config.scenario}`);
  lines.push(`- **Output**: \`${run_config.output_path}\``);
  lines.push("");

  // Summary table — primitive-agnostic
  lines.push("## Summary");
  lines.push("");

  const summaryEntries = Object.entries(result.summary as Record<string, SummaryValue>)
    .filter(([key]) => !LIFECYCLE_KEYS.has(key) && !STRUCTURED_SUMMARY_KEYS.has(key))
    .sort(([a], [b]) => a.localeCompare(b));

  if (summaryEntries.length > 0) {
    lines.push("| Metric | Value |");
    lines.push("|--------|-------|");
    for (const [key, value] of summaryEntries) {
      lines.push(`| ${key} | ${formatValue(value)} |`);
    }
  } else {
    lines.push("No domain metrics reported.");
  }
  lines.push("");

  // Lifecycle counters
  const active = (result.summary as Record<string, SummaryValue>).agents_active;
  const liquidated = (result.summary as Record<string, SummaryValue>).agents_liquidated;
  const depleted = (result.summary as Record<string, SummaryValue>).agents_depleted;
  lines.push(`**Agent lifecycle**: ${formatValue(active)} active, ${formatValue(liquidated)} liquidated, ${formatValue(depleted)} depleted`);
  lines.push("");

  // Invariants
  lines.push("## Invariants");
  lines.push("");
  const invariants = extractInvariants(result);
  if (invariants.length > 0) {
    lines.push("| Invariant | Firings | First tick |");
    lines.push("|-----------|---------|------------|");
    for (const inv of invariants) {
      lines.push(`| ${inv.name} | ${inv.firings} | T${inv.firstTick} |`);
    }
  } else {
    lines.push("No invariant violations detected in this run.");
  }
  lines.push("");

  // Notable events
  lines.push("## Notable events");
  lines.push("");
  const notable = extractNotableEvents(result);
  if (notable.length > 0) {
    for (const event of notable) {
      lines.push(`- ${event.description}`);
    }
  } else {
    lines.push("No notable events.");
  }
  lines.push("");

  // Boundaries
  if (result.simulation_boundaries.length > 0) {
    lines.push("## Simulation boundaries");
    lines.push("");
    for (const boundary of result.simulation_boundaries) {
      lines.push(`- ${boundary}`);
    }
    lines.push("");
  }

  // How to reproduce
  lines.push("## How to reproduce");
  lines.push("");
  if (config.reproCommand) {
    lines.push("```sh");
    lines.push(config.reproCommand);
    lines.push("```");
  } else {
    lines.push("```sh");
    lines.push("riptide sim run .riptide/sim --flows 8");
    lines.push("```");
  }
  lines.push("");

  return lines.join("\n");
}
