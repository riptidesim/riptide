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
  const parsed = parseJson(raw);
  if (parsed === undefined) {
    problems.push({
      code: "validate_context_malformed",
      message: `${ASSESSMENT_CONTEXT_FILE} is not valid JSON`,
      next: `rewrite ${ASSESSMENT_CONTEXT_FILE} as one JSON object, ${rerun}`
    });
    return null;
  }
  const version = isRecord(parsed) ? parsed.schema_version : undefined;
  if (version !== ASSESSMENT_CONTEXT_SCHEMA_VERSION) {
    problems.push({
      code: "validate_context_schema_unsupported",
      message: `${ASSESSMENT_CONTEXT_FILE} schema_version is ${JSON.stringify(version ?? null)}, expected ${JSON.stringify(ASSESSMENT_CONTEXT_SCHEMA_VERSION)}`,
      next: `set schema_version to ${JSON.stringify(ASSESSMENT_CONTEXT_SCHEMA_VERSION)} and match its shape, ${rerun}`
    });
    return null;
  }
  const result = AssessmentContextSchema.safeParse(parsed);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const field = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      problems.push({
        code: "validate_context_schema_invalid",
        message: `${ASSESSMENT_CONTEXT_FILE} ${field}: ${issue.message}`,
        next: `fix ${field} in ${ASSESSMENT_CONTEXT_FILE}, ${rerun}`
      });
    }
    return null;
  }

  const context = result.data;
  const gapSubjects = new Set(context.gaps.map((gap) => gap.subject));
  const uncovered = [
    ...context.coverage.instructions.not_exercised.map((name) => ({ kind: "instruction", name })),
    ...context.coverage.actors.not_exercised.map((name) => ({ kind: "actor", name }))
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

  const headings = [...raw.matchAll(/^## (.+?)\s*$/gm)].map((match) => match[1]!);
  const positions = REQUIRED_REPORT_SECTIONS.map((section) => headings.indexOf(section));
  const missing = REQUIRED_REPORT_SECTIONS.filter((_, index) => positions[index] === -1);
  for (const section of missing) {
    problems.push({
      code: "validate_report_section_missing",
      message: `${COMPOSED_REPORT_FILE} has no \`## ${section}\` section`,
      next: `add the \`## ${section}\` section to ${COMPOSED_REPORT_FILE}, ${rerun}`
    });
  }
  if (missing.length > 0) return;

  const inOrder = positions[0] === 0 && positions.every((pos, i) => i === 0 || pos > positions[i - 1]!);
  if (!inOrder) {
    problems.push({
      code: "validate_report_section_order",
      message: `${COMPOSED_REPORT_FILE} sections must open with ${REQUIRED_REPORT_SECTIONS.map((s) => `\`## ${s}\``).join(", then ")}`,
      next: `reorder ${COMPOSED_REPORT_FILE} so the Scope Declaration comes first, ${rerun}`
    });
  }

  if (digest !== null && !sectionBody(raw, "Engine Output").includes(digest)) {
    problems.push({
      code: "validate_report_engine_output_unlinked",
      message: `${COMPOSED_REPORT_FILE} \`## Engine Output\` does not cite the assessment digest ${digest}`,
      next: `put the Engine-rendered assessment.md under \`## Engine Output\` with its assessment digest, ${rerun}`
    });
  }
}

/** The text from a `## ` heading up to the next heading of the same level, or the end. */
function sectionBody(markdown: string, section: string): string {
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

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
