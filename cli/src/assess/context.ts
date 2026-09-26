// The Assessment Context: the agent-written sidecar that sits beside the
// Engine's `assessment.json` (ADR 0002), and the structural gate the Skill
// runs before it declares an Assessment complete. The gate checks structure
// only — required fields and sections — never the agent's prose.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { assessmentDigestOf } from "./model.js";
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
  "Engine Output"
] as const;

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
  gaps: z.array(z.object({ subject: text, reason: text, unblock: text }).strict())
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
  await checkReport(at, digest, problems);

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
      gaps: context.gaps.length
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
  return context;
}

async function checkReport(
  { dir, label, rerun }: CheckTarget,
  digest: string | null,
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
