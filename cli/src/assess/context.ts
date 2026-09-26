// The Assessment Context: the agent-written sidecar that sits beside the
// Engine's `assessment.json` (ADR 0002), and the structural gate the Skill
// runs before it declares an Assessment complete. The gate checks structure
// only — required fields and sections — never the agent's prose.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { assessmentDigestOf } from "./model.js";
import { FAMILIES, FLOOR_INVARIANTS, isFloorInvariant, type Family } from "../sim/floor-invariants.js";
import { canonicalJson, type JsonValue } from "../state-pack/json.js";
import type { CommandError } from "../contract/index.js";

export const ASSESSMENT_CONTEXT_SCHEMA_VERSION = "assessment-context.v1" as const;

export const ASSESSMENT_CONTEXT_FILE = "assessment-context.json";
export const ENGINE_OUTPUT_FILE = "assessment.json";
export const COMPOSED_REPORT_FILE = "assessment.md";

export const DEPTHS = ["default", "deep"] as const;

/** The `## ` headings the composed `assessment.md` carries, in this order, Scope Declaration first. */
export const REQUIRED_REPORT_SECTIONS = [
  "Scope Declaration",
  "Coverage",
  "Gaps",
  "Invariants",
  "Engine Output"
] as const;

export const PROVENANCES = ["floor", "agent"] as const;
export const FIRING_CHECK_RESULTS = ["fired", "did-not-fire", "not-run"] as const;
export const INVARIANT_OUTCOMES = ["held", "breached", "gap"] as const;

/** The npm package the Version Pin names; a Breach replays against exactly that Engine version. */
export const ENGINE_PACKAGE = "@riptide/cli";

/** The exact seed replay command for a Breach: `sim debug` on the Workspace's sim crate, run by the pinned Engine. */
export function breachReplayCommand(engineVersion: string, seed: string): string {
  return `npx --yes ${ENGINE_PACKAGE}@${engineVersion} sim debug .riptide/sim --seed ${seed}`;
}

/** A Causal Trace cites ticks as `T<n>` (`**T4**`, `T3–T7`). */
const TICK_CITATION = /\bT\d+\b/;

const text = z.string().trim().min(1);

const exercise = z
  .object({ exercised: z.array(text), not_exercised: z.array(text) })
  .strict()
  .superRefine((value, ctx) => {
    const exercised = new Set(value.exercised);
    for (const name of value.not_exercised) {
      if (exercised.has(name)) {
        ctx.addIssue({
          code: "custom",
          path: ["not_exercised"],
          message: `${JSON.stringify(name)} is listed as both exercised and not exercised`
        });
      }
    }
  });

export const AssessmentContextSchema = z.object({
  schema_version: z.literal(ASSESSMENT_CONTEXT_SCHEMA_VERSION),
  skill_version: text,
  engine_version: text,
  depth: z.enum(DEPTHS),
  scope_declaration: z.array(
    z.object({ assumption: text, reason: text, override: text }).strict()
  ),
  coverage: z.object({ instructions: exercise, actors: exercise }).strict(),
  gaps: z.array(z.object({ subject: text, reason: text, unblock: text }).strict()),
  family: z.enum(FAMILIES),
  invariants: z
    .array(
      z
        .object({
          id: text,
          provenance: z.enum(PROVENANCES),
          firing_check: z.enum(FIRING_CHECK_RESULTS),
          outcome: z.enum(INVARIANT_OUTCOMES)
        })
        .strict()
    )
    .superRefine((invariants, ctx) => {
      const seen = new Set<string>();
      invariants.forEach((invariant, index) => {
        if (seen.has(invariant.id)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "id"],
            message: `invariant ${JSON.stringify(invariant.id)} is listed more than once`
          });
        }
        seen.add(invariant.id);
      });
    }),
  // The replay command and Causal Trace are checked by the gate, so their absence gets its own code.
  breaches: z.array(
    z
      .object({
        invariant_id: text,
        seed: z.string().regex(/^[0-9a-fA-F]+$/, "must be the hex seed the run reported"),
        replay_command: z.string().optional(),
        causal_trace: z.string().optional()
      })
      .strict()
  )
});

export type AssessmentContext = z.infer<typeof AssessmentContextSchema>;

export interface ValidatedAssessment {
  assessment_dir: string;
  context_schema_version: typeof ASSESSMENT_CONTEXT_SCHEMA_VERSION;
  assessment_digest: string;
  depth: AssessmentContext["depth"];
  coverage: {
    instructions: { exercised: number; not_exercised: number };
    actors: { exercised: number; not_exercised: number };
  };
  gaps: number;
  family: Family;
  invariants: Record<(typeof PROVENANCES)[number] | (typeof INVARIANT_OUTCOMES)[number], number>;
  breaches: number;
}

export type AssessmentValidation =
  | { ok: true; result: ValidatedAssessment }
  | { ok: false; problems: CommandError[] };

/**
 * Check one Assessment directory: the Engine Output `assessment.json` is intact,
 * the Assessment Context sidecar is schema-valid, and the composed
 * `assessment.md` carries every required section and cites the Engine Output.
 * Collects every problem rather than stopping at the first.
 */
export async function validateAssessment(dir: string, label = dir): Promise<AssessmentValidation> {
  const problems: CommandError[] = [];
  const at = { dir, label, rerun: `then rerun \`riptide validate ${label} --json\`` };

  const digest = await checkEngineOutput(at, problems);
  const context = await checkContext(at, problems);
  await checkReport(at, digest, context, problems);

  if (problems.length > 0 || digest === null || context === null) return { ok: false, problems };
  return {
    ok: true,
    result: {
      assessment_dir: label,
      context_schema_version: context.schema_version,
      assessment_digest: digest,
      depth: context.depth,
      coverage: {
        instructions: counts(context.coverage.instructions),
        actors: counts(context.coverage.actors)
      },
      gaps: context.gaps.length,
      family: context.family,
      invariants: {
        floor: context.invariants.filter((inv) => inv.provenance === "floor").length,
        agent: context.invariants.filter((inv) => inv.provenance === "agent").length,
        held: context.invariants.filter((inv) => inv.outcome === "held").length,
        breached: context.invariants.filter((inv) => inv.outcome === "breached").length,
        gap: context.invariants.filter((inv) => inv.outcome === "gap").length
      },
      breaches: context.breaches.length
    }
  };
}

/** Where the checks read from, and how their messages name it. */
interface CheckTarget {
  dir: string;
  label: string;
  rerun: string;
}

async function checkEngineOutput(
  { dir, label, rerun }: CheckTarget,
  problems: CommandError[]
): Promise<string | null> {
  const render = `render the Engine Output with \`riptide assess <guided-sim-root> --out ${label} --json\`, ${rerun}`;
  const raw = await readOptional(path.join(dir, ENGINE_OUTPUT_FILE));
  if (raw === null) {
    problems.push({
      code: "validate_engine_output_missing",
      message: `${ENGINE_OUTPUT_FILE} not found in ${label}`,
      next: render
    });
    return null;
  }
  const parsed = parseJson(raw);
  const digest =
    isRecord(parsed) && typeof parsed.assessment_digest === "string" ? parsed.assessment_digest : null;
  if (!isRecord(parsed) || digest === null) {
    problems.push({
      code: "validate_engine_output_modified",
      message: `${ENGINE_OUTPUT_FILE} is not an Engine-rendered assessment (no assessment_digest)`,
      next: render
    });
    return null;
  }
  const { assessment_digest: _digest, ...facts } = parsed;
  const expected = assessmentDigestOf(facts);
  if (expected !== digest || canonicalJson(parsed as JsonValue) !== raw) {
    problems.push({
      code: "validate_engine_output_modified",
      message: `${ENGINE_OUTPUT_FILE} does not match its assessment_digest; Engine Output was edited after rendering`,
      next: `never edit Engine Output: ${render}`
    });
    return null;
  }
  return digest;
}

async function checkContext(
  { dir, label, rerun }: CheckTarget,
  problems: CommandError[]
): Promise<AssessmentContext | null> {
  const raw = await readOptional(path.join(dir, ASSESSMENT_CONTEXT_FILE));
  if (raw === null) {
    problems.push({
      code: "validate_context_missing",
      message: `${ASSESSMENT_CONTEXT_FILE} not found in ${label}`,
      next: `write the Assessment Context beside ${ENGINE_OUTPUT_FILE}, ${rerun}`
    });
    return null;
  }
  const context = parseVersioned(
    raw,
    ASSESSMENT_CONTEXT_FILE,
    ASSESSMENT_CONTEXT_SCHEMA_VERSION,
    AssessmentContextSchema,
    "validate_context",
    rerun,
    problems
  );
  if (context === null) return null;

  // An actor is exercised only through an instruction, so no exercised instruction is zero Coverage.
  if (context.coverage.instructions.exercised.length === 0) {
    problems.push({
      code: "validate_coverage_zero",
      message: `${ASSESSMENT_CONTEXT_FILE} exercises no instruction; an Assessment needs Coverage`,
      next:
        "deliver a Blocker Report instead: write blocker-report.json and blocker-report.md " +
        "into their own directory and run `riptide validate` on it"
    });
  }
  const { instructions, actors } = context.coverage;
  checkGapsCover(instructions.not_exercised, actors.not_exercised, context.gaps, rerun, problems);
  checkInvariants(context, rerun, problems);
  checkBreaches(context, rerun, problems);
  return context;
}

/**
 * Every Floor Invariant of the family is reported with `floor` provenance and
 * nothing else is; an invariant counts as held or breached only once its
 * Firing Check fired; an invariant reported as a Gap has one.
 */
function checkInvariants(context: AssessmentContext, rerun: string, problems: CommandError[]): void {
  const { family, invariants, gaps } = context;
  const reported = new Set(invariants.map((inv) => inv.id));
  for (const floor of FLOOR_INVARIANTS[family]) {
    if (!reported.has(floor.id)) {
      problems.push({
        code: "validate_floor_invariant_missing",
        message: `Floor Invariant ${JSON.stringify(floor.id)} of the ${family} family is not reported`,
        next:
          `report ${JSON.stringify(floor.id)} with provenance "floor": wire it through \`riptide sim generate\` ` +
          `(data.floor_invariants), run its Firing Check, and record its outcome, or its Gap, ${rerun}`
      });
    }
  }

  const gapSubjects = new Set(gaps.map((gap) => gap.subject));
  for (const inv of invariants) {
    const floor = isFloorInvariant(family, inv.id);
    if (floor !== (inv.provenance === "floor")) {
      problems.push({
        code: "validate_invariant_provenance_mismatch",
        message: floor
          ? `invariant ${JSON.stringify(inv.id)} is a Floor Invariant of the ${family} family but is labelled agent-authored`
          : `invariant ${JSON.stringify(inv.id)} is not a Floor Invariant of the ${family} family but is labelled floor`,
        next: `set its provenance to ${JSON.stringify(floor ? "floor" : "agent")}, ${rerun}`
      });
    }
    if (inv.outcome !== "gap" && inv.firing_check !== "fired") {
      problems.push({
        code: "validate_invariant_not_fired",
        message: `invariant ${JSON.stringify(inv.id)} is reported as ${inv.outcome} but its Firing Check is ${inv.firing_check}`,
        next:
          `an invariant counts only after its Firing Check fires: set its outcome to "gap" and add a Gap ` +
          `with subject ${JSON.stringify(inv.id)}, or repair it until \`riptide sim run .riptide/sim --firing-check --json\` reports it fired, ${rerun}`
      });
    }
    if (inv.outcome === "gap" && !gapSubjects.has(inv.id)) {
      problems.push({
        code: "validate_gap_missing",
        message: `invariant ${JSON.stringify(inv.id)} is reported as a Gap but has no Gap`,
        next: `add a Gap with subject ${JSON.stringify(inv.id)}, its reason and what would unblock it, ${rerun}`
      });
    }
  }
}

/**
 * Every breached invariant has a Breach and every Breach names a breached
 * invariant; each Breach carries the exact replay command against the pinned
 * Engine and a Causal Trace that cites ticks.
 */
function checkBreaches(context: AssessmentContext, rerun: string, problems: CommandError[]): void {
  const { invariants, breaches, engine_version } = context;
  const breached = new Set(breaches.map((breach) => breach.invariant_id));
  for (const inv of invariants) {
    if (inv.outcome === "breached" && !breached.has(inv.id)) {
      problems.push({
        code: "validate_breach_missing",
        message: `invariant ${JSON.stringify(inv.id)} is reported as breached but has no Breach`,
        next:
          `add a Breach with invariant_id ${JSON.stringify(inv.id)}, the seed it fired at, its replay command ` +
          `and its Causal Trace, ${rerun}`
      });
    }
  }

  const outcomes = new Map(invariants.map((inv) => [inv.id, inv.outcome]));
  for (const breach of breaches) {
    const id = JSON.stringify(breach.invariant_id);
    const what = `Breach of invariant ${id} at seed ${breach.seed}`;
    const outcome = outcomes.get(breach.invariant_id);
    if (outcome !== "breached") {
      problems.push({
        code: "validate_breach_invariant_mismatch",
        message:
          outcome === undefined
            ? `${what} names ${id}, which is not a reported invariant`
            : `${what} names ${id}, which is reported as ${outcome}`,
        next: `set the invariant_id of the Breach to a reported invariant whose outcome is "breached", ${rerun}`
      });
    }

    const replay = breachReplayCommand(engine_version, breach.seed);
    if (!breach.replay_command?.trim()) {
      problems.push({
        code: "validate_breach_replay_missing",
        message: `${what} has no replay command`,
        next: `set its replay_command to \`${replay}\`, ${rerun}`
      });
    } else if (breach.replay_command !== replay) {
      problems.push({
        code: "validate_breach_replay_unpinned",
        message: `${what} has a replay command that is not the seed's replay against the pinned Engine ${engine_version}`,
        next: `set its replay_command to exactly \`${replay}\`, ${rerun}`
      });
    }

    const debug = `riptide sim debug .riptide/sim --seed ${breach.seed} --json`;
    if (!breach.causal_trace?.trim()) {
      problems.push({
        code: "validate_breach_causal_trace_missing",
        message: `${what} has no Causal Trace`,
        next: `replay the seed with \`${debug}\` and write its Causal Trace from data.log (see causal-trace.md), ${rerun}`
      });
    } else if (!TICK_CITATION.test(breach.causal_trace)) {
      problems.push({
        code: "validate_breach_causal_trace_uncited",
        message: `${what} has a Causal Trace that cites no tick`,
        next:
          `cite the ticks from \`${debug}\` data.log as **T<n>** in its mechanism and timeline ` +
          `(see causal-trace.md), ${rerun}`
      });
    }
  }
}

async function checkReport(
  { dir, label, rerun }: CheckTarget,
  digest: string | null,
  context: AssessmentContext | null,
  problems: CommandError[]
): Promise<void> {
  const raw = await readOptional(path.join(dir, COMPOSED_REPORT_FILE));
  if (raw === null) {
    problems.push({
      code: "validate_report_missing",
      message: `${COMPOSED_REPORT_FILE} not found in ${label}`,
      next: `compose ${COMPOSED_REPORT_FILE} from the Assessment Context and the Engine Output, ${rerun}`
    });
    return;
  }

  if (!checkSections(raw, COMPOSED_REPORT_FILE, REQUIRED_REPORT_SECTIONS, rerun, problems)) return;

  if (digest !== null && !sectionBody(raw, "Engine Output").includes(digest)) {
    problems.push({
      code: "validate_report_engine_output_unlinked",
      message: `${COMPOSED_REPORT_FILE} \`## Engine Output\` does not cite the assessment digest ${digest}`,
      next: `put the Engine-rendered assessment.md under \`## Engine Output\` with its assessment digest, ${rerun}`
    });
  }

  if (context !== null && context.breaches.length > 0) checkBreachesSection(raw, context, rerun, problems);

  const listed = sectionBody(raw, "Invariants");
  for (const inv of context?.invariants ?? []) {
    if (!listed.includes(inv.id)) {
      problems.push({
        code: "validate_report_invariant_unlisted",
        message: `${COMPOSED_REPORT_FILE} \`## Invariants\` does not name invariant ${JSON.stringify(inv.id)}`,
        next: `list ${JSON.stringify(inv.id)} under \`## Invariants\` with its provenance, Firing Check result and outcome, ${rerun}`
      });
    }
  }
}

/** With a Breach, `## Breaches` sits between `## Invariants` and `## Engine Output` and lists every replay command. */
function checkBreachesSection(
  markdown: string,
  context: AssessmentContext,
  rerun: string,
  problems: CommandError[]
): void {
  const headings = [...markdown.matchAll(/^## (.+?)\s*$/gm)].map((match) => match[1]!);
  const at = headings.indexOf("Breaches");
  if (at === -1) {
    problems.push({
      code: "validate_report_section_missing",
      message: `${COMPOSED_REPORT_FILE} has no \`## Breaches\` section, but the Assessment Context reports a Breach`,
      next: `add \`## Breaches\` between \`## Invariants\` and \`## Engine Output\`, ${rerun}`
    });
    return;
  }
  if (!(at > headings.indexOf("Invariants") && at < headings.indexOf("Engine Output"))) {
    problems.push({
      code: "validate_report_section_order",
      message: `${COMPOSED_REPORT_FILE} \`## Breaches\` must sit between \`## Invariants\` and \`## Engine Output\``,
      next: `move \`## Breaches\` after \`## Invariants\` and before \`## Engine Output\`, ${rerun}`
    });
  }
  const listed = sectionBody(markdown, "Breaches");
  for (const breach of context.breaches) {
    const replay = breachReplayCommand(context.engine_version, breach.seed);
    if (!listed.includes(replay)) {
      problems.push({
        code: "validate_report_breach_unlisted",
        message: `${COMPOSED_REPORT_FILE} \`## Breaches\` does not give the replay command for the Breach of ${JSON.stringify(breach.invariant_id)} at seed ${breach.seed}`,
        next: `list the Breach under \`## Breaches\` with its replay command \`${replay}\` and its Causal Trace, ${rerun}`
      });
    }
  }
}

/**
 * Parse an agent-written JSON file against its versioned schema. Problems are
 * coded `<prefix>_malformed`, `<prefix>_schema_unsupported` and
 * `<prefix>_schema_invalid`, the last once per failing field.
 */
export function parseVersioned<T>(
  raw: string,
  file: string,
  version: string,
  schema: z.ZodType<T>,
  prefix: string,
  rerun: string,
  problems: CommandError[]
): T | null {
  const parsed = parseJson(raw);
  if (parsed === undefined) {
    problems.push({
      code: `${prefix}_malformed`,
      message: `${file} is not valid JSON`,
      next: `rewrite ${file} as one JSON object, ${rerun}`
    });
    return null;
  }
  const found = isRecord(parsed) ? parsed.schema_version : undefined;
  if (found !== version) {
    problems.push({
      code: `${prefix}_schema_unsupported`,
      message: `${file} schema_version is ${JSON.stringify(found ?? null)}, expected ${JSON.stringify(version)}`,
      next: `set schema_version to ${JSON.stringify(version)} and match its shape, ${rerun}`
    });
    return null;
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      problems.push({
        code: `${prefix}_schema_invalid`,
        message: `${file} ${field}: ${issue.message}`,
        next: `fix ${field} in ${file}, ${rerun}`
      });
    }
    return null;
  }
  return result.data;
}

/** Every unexercised instruction and actor must be the subject of a Gap. */
export function checkGapsCover(
  instructions: string[],
  actors: string[],
  gaps: Array<{ subject: string }>,
  rerun: string,
  problems: CommandError[]
): void {
  const gapSubjects = new Set(gaps.map((gap) => gap.subject));
  const uncovered = [
    ...instructions.map((name) => ({ kind: "instruction", name })),
    ...actors.map((name) => ({ kind: "actor", name }))
  ];
  for (const { kind, name } of uncovered) {
    if (!gapSubjects.has(name)) {
      problems.push({
        code: "validate_gap_missing",
        message: `${kind} ${JSON.stringify(name)} was not exercised but has no Gap`,
        next: `add a Gap with subject ${JSON.stringify(name)}, its reason and what would unblock it, ${rerun}`
      });
    }
  }
}

/**
 * Check that a composed report carries every `required` `## ` section, opening
 * with the first and in the given order. Returns false when a section is missing.
 */
export function checkSections(
  markdown: string,
  file: string,
  required: readonly string[],
  rerun: string,
  problems: CommandError[]
): boolean {
  const headings = [...markdown.matchAll(/^## (.+?)\s*$/gm)].map((match) => match[1]!);
  const positions = required.map((section) => headings.indexOf(section));
  const missing = required.filter((_, index) => positions[index] === -1);
  for (const section of missing) {
    problems.push({
      code: "validate_report_section_missing",
      message: `${file} has no \`## ${section}\` section`,
      next: `add the \`## ${section}\` section to ${file}, ${rerun}`
    });
  }
  if (missing.length > 0) return false;

  const inOrder = positions[0] === 0 && positions.every((pos, i) => i === 0 || pos > positions[i - 1]!);
  if (!inOrder) {
    problems.push({
      code: "validate_report_section_order",
      message: `${file} sections must open with ${required.map((s) => `\`## ${s}\``).join(", then ")}`,
      next: `reorder ${file} so the ${required[0]} comes first, ${rerun}`
    });
  }
  return true;
}

/** The text from a `## ` heading up to the next heading of the same level, or the end. */
export function sectionBody(markdown: string, section: string): string {
  const start = markdown.search(new RegExp(`^## ${section}\\s*$`, "m"));
  if (start === -1) return "";
  const rest = markdown.slice(start).replace(/^.*\n?/, "");
  const end = rest.search(/^## /m);
  return end === -1 ? rest : rest.slice(0, end);
}

function counts(value: { exercised: string[]; not_exercised: string[] }): {
  exercised: number;
  not_exercised: number;
} {
  return { exercised: value.exercised.length, not_exercised: value.not_exercised.length };
}

export async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
}

export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
