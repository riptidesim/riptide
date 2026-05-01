// `riptide explain <adapter>` — reviewer-readable inspection of a parsed
// adapter TOML.
//
// Inspection-only: this command does NOT fetch IDLs at run time, does
// NOT validate the adapter against the IDL, and does NOT run an engine
// smoke test. It loads the adapter through the shared resolver and
// renders the already-validated schema into stable prose.
//
// Exit codes:
//   0 — adapter loaded and rendered
//   1 — unexpected render / stdout error after the adapter parsed
//   2 — adapter not found, unreadable, or failed validation

import { Command } from "commander";

import { loadAdapter, type AdapterLoadError } from "../adapter/resolve.js";
import {
  resolveAdapterRuntime,
  type Adapter,
  type ArgLiteral,
  type OracleBinding,
  type ScheduledAction,
} from "../schemas/adapter.js";
import { renderLineage } from "./lineage.js";

export interface ExplainCommandDeps {
  /** Override the fixtures root used for adapter-name resolution. */
  fixturesRoot?: string;
  /** Override cwd used for the downstream `.riptide/adapters/` layer. */
  cwd?: string;
  /** Stdout sink (defaults to `process.stdout.write`). Tests inject a buffer. */
  stdoutWrite?: (chunk: string) => void;
  /** Stderr sink (defaults to `process.stderr.write`). Tests inject a buffer. */
  stderrWrite?: (chunk: string) => void;
}

export interface ExplainOptions {
  // Reserved for future flags (e.g. `--json`).
}

export function createExplainCommand(deps: ExplainCommandDeps = {}): Command {
  const command = new Command("explain")
    .description(
      "Pretty-print a parsed adapter TOML in reviewer-readable form (inspection-only — no IDL fetch, no engine smoke)"
    )
    .argument(
      "<adapter>",
      "Adapter name (e.g. lending) resolved under .riptide/adapters/ or fixtures/adapters/, or an explicit adapter TOML path"
    );

  return command.action(async (adapter: string, options: ExplainOptions) => {
    const exitCode = await runExplain(adapter, options, deps);
    process.exit(exitCode);
  });
}

export async function runExplain(
  adapterArg: string,
  _options: ExplainOptions,
  deps: ExplainCommandDeps = {}
): Promise<number> {
  const stdout = deps.stdoutWrite ?? ((chunk: string) => process.stdout.write(chunk));
  const stderr = deps.stderrWrite ?? ((chunk: string) => process.stderr.write(chunk));

  const loaded = await loadAdapter(adapterArg, {
    fixturesRoot: deps.fixturesRoot,
    cwd: deps.cwd,
  });

  if (!loaded.ok) {
    stderr(renderLoadError(loaded.error));
    return 2;
  }

  try {
    stdout(renderAdapterExplain(loaded.value.resolved.displayName, loaded.value.adapter));
    return 0;
  } catch (err) {
    stderr(`riptide explain: could not render adapter: ${errMessage(err)}\n`);
    return 1;
  }
}

/**
 * Render a parsed adapter into a stable, reviewer-readable text view.
 * Exported so tests can pin byte-for-byte output without invoking the
 * CLI spawn path.
 */
export function renderAdapterExplain(displayName: string, adapter: Adapter): string {
  const lines: string[] = [];
  lines.push(`Adapter — ${displayName}`);
  lines.push("");

  lines.push("Runtime:");
  lines.push(`  protocol: ${resolveAdapterRuntime(adapter)}`);
  lines.push(`  program_so: ${adapter.program_so ?? "(none)"}`);
  lines.push(`  idl_path:   ${adapter.idl_path ?? "(none)"}`);
  lines.push("");

  renderRecordSection(lines, "Accounts:", adapter.accounts, renderAccount);
  renderRecordSection(lines, "Instructions:", adapter.instructions, renderInstruction);
  renderRecordSection(lines, "State mapping:", adapter.state_mapping, (key, logical) => `${key} → ${logical}`);
  renderRecordSection(lines, "Actions:", adapter.actions, renderAction);
  renderRecordSection(lines, "Observations:", adapter.observations, renderObservation);
  renderRecordSection(lines, "Personas:", adapter.personas, renderPersona);

  lines.push("Invariants (flat):");
  if (adapter.invariants.length === 0) {
    lines.push("  (none declared)");
  } else {
    for (const invariant of adapter.invariants) {
      pushWrapped(lines, `  ${renderFlatInvariant(invariant)}`);
    }
  }
  lines.push("");

  if (adapter.semantics !== undefined) {
    renderSemantics(lines, adapter.semantics);
  }

  lines.push("Oracles:");
  if (adapter.oracles.length === 0) {
    lines.push("  (none declared)");
  } else {
    for (const oracle of [...adapter.oracles].sort((a, b) => a.name.localeCompare(b.name))) {
      pushWrapped(lines, `  ${renderOracle(oracle)}`);
    }
  }
  lines.push("");

  lines.push("Scheduled actions:");
  if (adapter.scheduled_actions.length === 0) {
    lines.push("  (none declared)");
  } else {
    for (const scheduled of adapter.scheduled_actions) {
      pushWrapped(lines, `  ${renderScheduledAction(scheduled)}`);
    }
  }
  lines.push("");

  lines.push(...renderLineage(displayName, adapter.lineage).trimEnd().split("\n"));
  lines.push("");

  return lines.join("\n");
}

function renderLoadError(error: AdapterLoadError): string {
  switch (error.kind) {
    case "not-found":
      return (
        `riptide explain: adapter not found for \`${error.arg}\`. ` +
        `Pass an explicit path, or check that .riptide/adapters/${error.arg}.toml exists, ` +
        `or fixtures/adapters/${error.arg}.toml.\n`
      );
    case "read-failed":
      return `riptide explain: could not read adapter at ${error.path}: ${error.message}\n`;
    case "validation-failed":
      return `riptide explain: adapter failed validation: ${error.message}\n`;
  }
}

function renderRecordSection<T>(
  lines: string[],
  heading: string,
  record: Record<string, T>,
  renderEntry: (key: string, value: T) => string
): void {
  lines.push(heading);
  const keys = Object.keys(record).sort();
  if (keys.length === 0) {
    lines.push("  (none declared)");
  } else {
    for (const key of keys) {
      pushWrapped(lines, `  ${renderEntry(key, record[key]!)}`);
    }
  }
  lines.push("");
}

function renderAccount(name: string, account: Adapter["accounts"][string]): string {
  const parts = [`kind=${account.kind}`, `space=${account.space}`];
  if (account.address !== undefined) {
    parts.push(`address=${account.address}`);
  }
  if (account.pda !== undefined) {
    parts.push(`pda=${formatStringArray(account.pda.seeds)}`);
    if (account.pda.program !== undefined) {
      parts.push(`pda_program=${account.pda.program}`);
    }
  }
  if (account.owner !== undefined) {
    parts.push(`owner=${formatAccountOwner(account.owner)}`);
  }
  if (account.decoder !== undefined) {
    parts.push(`decoder=${formatAccountDecoder(account.decoder)}`);
  }
  return `${name} ${parts.join("; ")}`;
}

function renderInstruction(
  name: string,
  instruction: Adapter["instructions"][string]
): string {
  const parts = [`action=${instruction.action}`];
  if (instruction.amount !== undefined) {
    parts.push(`amount=${instruction.amount}`);
  }
  if (Object.keys(instruction.args).length > 0) {
    parts.push(`args=${formatArgMap(instruction.args, "=")}`);
  }
  return `${name} → ${parts.join(", ")}`;
}

function renderAction(name: string, action: Adapter["actions"][string]): string {
  const parts = [`takes=${formatStringArray(action.takes)}`];
  if (action.label !== undefined) {
    parts.push(`label=${formatStringLiteral(action.label)}`);
  }
  return `${name} ${parts.join(" ")}`;
}

function renderObservation(
  name: string,
  observation: Adapter["observations"][string]
): string {
  if (typeof observation === "string") {
    return `${name} ${observation}`;
  }

  const parts: string[] = [observation.type];
  if (observation.label !== undefined) {
    parts.push(`label=${formatStringLiteral(observation.label)}`);
  }
  return `${name} ${parts.join(" ")}`;
}

function renderPersona(name: string, persona: Adapter["personas"][string]): string {
  const parts = [
    `rate=${formatNumber(persona.action_rate_multiplier)}`,
    `weights=${formatNumberMap(persona.action_weights)}`,
  ];

  if (persona.triggers.length > 0) {
    parts.push(`triggers=${formatPersonaTriggers(persona.triggers)}`);
  }
  if (Object.keys(persona.persona_args).length > 0) {
    parts.push(`args=${formatArgMap(persona.persona_args, "=")}`);
  }
  if (persona.label !== undefined) {
    parts.push(`label=${formatStringLiteral(persona.label)}`);
  }
  return `${name} ${parts.join(" ")}`;
}

function renderFlatInvariant(invariant: Adapter["invariants"][number]): string {
  const expr = `${invariant.field} ${invariant.op} ${formatNumber(invariant.value)}`;
  if (invariant.name !== undefined && invariant.name !== invariant.field) {
    return `${invariant.name}: ${expr} [error]`;
  }
  return `${expr} [error]`;
}

function renderSemantics(lines: string[], semantics: NonNullable<Adapter["semantics"]>): void {
  lines.push("Semantics:");
  lines.push(`  class: ${semantics.class ?? "(none)"}`);

  lines.push("  Roles:");
  const roleNames = Object.keys(semantics.roles).sort();
  if (roleNames.length === 0) {
    lines.push("    (none declared)");
  } else {
    const roleWidth = Math.max(...roleNames.map((name) => name.length));
    for (const roleName of roleNames) {
      const role = semantics.roles[roleName]!;
      const padded = roleName.padEnd(roleWidth, " ");
      pushWrapped(lines, `    ${padded} source=${role.source}`, `    ${" ".repeat(roleWidth)} `);
      pushWrapped(
        lines,
        `    ${" ".repeat(roleWidth)} fields=${formatSemanticFields(role.fields)}`,
        `    ${" ".repeat(roleWidth)} `
      );
    }
  }

  lines.push("  Derived:");
  const derivedNames = Object.keys(semantics.derived).sort();
  if (derivedNames.length === 0) {
    lines.push("    (none declared)");
  } else {
    for (const name of derivedNames) {
      pushWrapped(lines, `    ${name} = ${semantics.derived[name]!}`, "    ");
    }
  }

  if (Object.keys(semantics.collections).length > 0) {
    lines.push("  Collections:");
    for (const name of Object.keys(semantics.collections).sort()) {
      const collection = semantics.collections[name]!;
      pushWrapped(
        lines,
        `    ${name} over=${collection.over} formula=${collection.formula} expr=${formatStringLiteral(collection.expr)}`,
        "    "
      );
    }
  }

  if (Object.keys(semantics.oracles).length > 0) {
    lines.push("  Oracle bindings:");
    for (const roleName of Object.keys(semantics.oracles).sort()) {
      const bindings = semantics.oracles[roleName]!;
      bindings.forEach((binding, idx) => {
        pushWrapped(
          lines,
          `    ${roleName}[${idx}] ${renderOracleBinding(binding)}`,
          "    "
        );
      });
    }
  }

  if (semantics.replay !== undefined) {
    const replayParts: string[] = [];
    if (semantics.replay.state_source !== undefined) {
      replayParts.push(`state_source=${semantics.replay.state_source}`);
    }
    if (semantics.replay.pack_path !== undefined) {
      replayParts.push(`pack_path=${semantics.replay.pack_path}`);
    }
    if (semantics.replay.slot !== undefined) {
      replayParts.push(`slot=${semantics.replay.slot}`);
    }
    replayParts.push(`roles=${formatStringMap(semantics.replay.roles, "=")}`);
    pushWrapped(lines, `  Replay: ${replayParts.join(" ")}`, "    ");
  }

  if (Object.keys(semantics.extensions).length > 0) {
    lines.push("  Extensions:");
    for (const name of Object.keys(semantics.extensions).sort()) {
      pushWrapped(lines, `    ${name} = ${stableJson(semantics.extensions[name])}`, "    ");
    }
  }

  lines.push("  Invariants (semantic):");
  if (semantics.invariants.length === 0) {
    lines.push("    (none declared)");
  } else {
    for (const invariant of semantics.invariants) {
      const desc =
        invariant.description !== undefined
          ? ` description=${formatStringLiteral(invariant.description)}`
          : "";
      pushWrapped(
        lines,
        `    ${invariant.name} expr=${formatStringLiteral(invariant.expr)} [${invariant.severity}]${desc}`,
        "    "
      );
    }
  }
  lines.push("");
}

function renderOracle(oracle: Adapter["oracles"][number]): string {
  const parts = [
    `kind=${oracle.kind}`,
    `base=${formatNumber(oracle.base_price)}`,
    `expo=${oracle.exponent}`,
  ];
  if (oracle.account !== undefined) {
    parts.push(`account=${oracle.account}`);
  }
  if (oracle.confidence !== undefined) {
    parts.push(`confidence=${oracle.confidence}`);
  }
  return `${oracle.name} ${parts.join(" ")}`;
}

function renderScheduledAction(action: ScheduledAction): string {
  const displayName = action.name ?? action.instruction;
  const parts = [`every ${action.interval_ticks} ticks`];
  if (action.name !== undefined && action.name !== action.instruction) {
    parts.push(`instruction=${action.instruction}`);
  }
  parts.push(`accounts=${formatStringArray(action.accounts)}`);
  parts.push(`args=${formatUnknownMap(action.args)}`);
  return `${displayName} ${parts.join(" ")}`;
}

function renderOracleBinding(binding: OracleBinding): string {
  const parts = [
    `program_id=${binding.program_id}`,
    `account=${binding.account}`,
    `confidence=${binding.confidence}`,
    `staleness=${binding.staleness}`,
  ];
  if (binding.weight !== undefined) {
    parts.push(`weight=${binding.weight}`);
  }
  return parts.join(" ");
}

function formatAccountOwner(owner: Adapter["accounts"][string]["owner"]): string {
  if (owner === undefined) return "(none)";
  if (owner.program_so !== undefined) return `program_so:${owner.program_so}`;
  if (owner.pubkey !== undefined) return `pubkey:${owner.pubkey}`;
  return "(empty)";
}

function formatAccountDecoder(decoder: Adapter["accounts"][string]["decoder"]): string {
  if (decoder === undefined) return "(none)";
  if (typeof decoder === "string") return decoder;
  return `${decoder.kind}:${Object.keys(decoder.fields).sort().join(",")}`;
}

function formatSemanticFields(fields: Record<string, string>): string {
  return formatStringMap(fields, ": ");
}

function formatPersonaTriggers(triggers: Adapter["personas"][string]["triggers"]): string {
  return `[${triggers
    .map((trigger) => (
      `${trigger.if} -> ${trigger.then} (+${formatNumber(trigger.weight_boost)})`
    ))
    .join(", ")}]`;
}

function formatStringArray(values: string[]): string {
  return `[${values.map((value) => formatStringLiteral(value)).join(", ")}]`;
}

function formatNumberMap(record: Record<string, number>): string {
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${key}:${formatNumber(record[key]!)}`)
    .join(", ")}}`;
}

function formatStringMap(record: Record<string, string>, separator: string): string {
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${key}${separator}${record[key]!}`)
    .join(", ")}}`;
}

function formatArgMap(record: Record<string, ArgLiteral>, separator: string): string {
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${key}${separator}${formatLiteral(record[key]!)}`)
    .join(", ")}}`;
}

function formatUnknownMap(record: Record<string, unknown>): string {
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${key}=${stableJson(record[key])}`)
    .join(", ")}}`;
}

function formatLiteral(value: ArgLiteral): string {
  if (typeof value === "string") return formatStringLiteral(value);
  if (typeof value === "number") return formatNumber(value);
  return String(value);
}

function formatStringLiteral(value: string): string {
  return JSON.stringify(value);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function stableJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function pushWrapped(
  lines: string[],
  line: string,
  continuationIndent = "    ",
  limit = 120
): void {
  let rest = line;
  while (rest.length > limit) {
    const comma = rest.indexOf(",", limit);
    if (comma === -1) break;
    lines.push(rest.slice(0, comma + 1).trimEnd());
    rest = `${continuationIndent}${rest.slice(comma + 1).trimStart()}`;
  }
  lines.push(rest);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
