// The three outputs the Skill can deliver — an Assessment, an Out-of-Scope
// Note or a Blocker Report — and the gate that recognises which one a
// directory holds. The Skill decides the kind; the Engine only validates it.
// Neither the Out-of-Scope Note nor the Blocker Report may carry Engine Output
// or any section that describes a risk surface.

import { access } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  ASSESSMENT_CONTEXT_FILE,
  COMPOSED_REPORT_FILE,
  DEPTHS,
  ENGINE_OUTPUT_FILE,
  checkGapsCover,
  checkSections,
  parseVersioned,
  readOptional,
  sectionBody,
  validateAssessment,
  type ValidatedAssessment
} from "./context.js";
import type { CommandError } from "../contract/index.js";

export const OUT_OF_SCOPE_NOTE_SCHEMA_VERSION = "out-of-scope-note.v1" as const;
export const BLOCKER_REPORT_SCHEMA_VERSION = "blocker-report.v1" as const;

export const OUT_OF_SCOPE_NOTE_FILE = "out-of-scope-note.json";
export const OUT_OF_SCOPE_NOTE_REPORT = "out-of-scope-note.md";
export const BLOCKER_REPORT_FILE = "blocker-report.json";
export const BLOCKER_REPORT_REPORT = "blocker-report.md";

export const OUT_OF_SCOPE_NOTE_SECTIONS = ["Classification", "Code-Level Auditing"] as const;
export const BLOCKER_REPORT_SECTIONS = ["Scope Declaration", "Blocker", "Gaps"] as const;

/** Sections that describe a risk surface; neither short-circuit output may carry one. */
const RISK_SURFACE_SECTIONS = [
  "Coverage",
  "Engine Output",
  "Region Coverage",
  "Risk Surface",
  "Invariants",
  "Breaches",
  "Delta"
] as const;

/** Files only the Engine renders from a simulation. */
const ENGINE_OUTPUT_FILES = [
  ENGINE_OUTPUT_FILE,
  "campaign-summary.json",
  "risk-surface.json",
  "brief.html",
  "brief.pdf"
] as const;

const text = z.string().trim().min(1);

export const OutOfScopeNoteSchema = z
  .object({
    schema_version: z.literal(OUT_OF_SCOPE_NOTE_SCHEMA_VERSION),
    skill_version: text,
    engine_version: text,
    target: text,
    classification: z
      .object({ verdict: z.literal("not-economic-protocol"), evidence: z.array(text).min(1), override: text })
      .strict(),
    referrals: z.array(text).min(1)
  })
  .strict();

export const BlockerReportSchema = z
  .object({
    schema_version: z.literal(BLOCKER_REPORT_SCHEMA_VERSION),
    skill_version: text,
    engine_version: text,
    depth: z.enum(DEPTHS),
    scope_declaration: z.array(z.object({ assumption: text, reason: text, override: text }).strict()),
    blocker: z.object({ command: text, error: text }).strict(),
    not_exercised: z.object({ instructions: z.array(text), actors: z.array(text) }).strict(),
    gaps: z.array(z.object({ subject: text, reason: text, unblock: text }).strict()).min(1)
  })
  .strict();

export type OutputKind = "assessment" | "out-of-scope-note" | "blocker-report";

export type ValidatedOutput =
  | ({ kind: "assessment" } & ValidatedAssessment)
  | {
      kind: "out-of-scope-note";
      assessment_dir: string;
      note_schema_version: typeof OUT_OF_SCOPE_NOTE_SCHEMA_VERSION;
      evidence: number;
      referrals: number;
    }
  | {
      kind: "blocker-report";
      assessment_dir: string;
      report_schema_version: typeof BLOCKER_REPORT_SCHEMA_VERSION;
      depth: (typeof DEPTHS)[number];
      gaps: number;
    };

export type OutputValidation =
  | { ok: true; result: ValidatedOutput }
  | { ok: false; kind: OutputKind | null; problems: CommandError[] };

const SIDECARS: Array<[OutputKind, string]> = [
  ["assessment", ASSESSMENT_CONTEXT_FILE],
  ["out-of-scope-note", OUT_OF_SCOPE_NOTE_FILE],
  ["blocker-report", BLOCKER_REPORT_FILE]
];

/**
 * Validate whichever output `dir` holds. The kind is read from the one
 * agent-written file present; a directory with Engine Output but no sidecar is
 * an Assessment whose Assessment Context is missing.
 */
export async function validateOutput(dir: string, label = dir): Promise<OutputValidation> {
  const rerun = `then rerun \`riptide validate ${label} --json\``;
  const present: OutputKind[] = [];
  for (const [kind, file] of SIDECARS) {
    if (await exists(path.join(dir, file))) present.push(kind);
  }

  if (present.length > 1) {
    return {
      ok: false,
      kind: null,
      problems: [
        {
          code: "validate_output_ambiguous",
          message: `${label} holds more than one output: ${present.join(", ")}`,
          next: `keep exactly one of ${SIDECARS.map(([, file]) => file).join(", ")} in ${label}, ${rerun}`
        }
      ]
    };
  }

  const engineRendered =
    (await exists(path.join(dir, ENGINE_OUTPUT_FILE))) || (await exists(path.join(dir, COMPOSED_REPORT_FILE)));
  const kind = present[0] ?? (engineRendered ? "assessment" : null);

  if (kind === null) {
    return {
      ok: false,
      kind: null,
      problems: [
        {
          code: "validate_output_missing",
          message: `${label} holds no Assessment, Out-of-Scope Note or Blocker Report`,
          next: `write ${ASSESSMENT_CONTEXT_FILE}, ${OUT_OF_SCOPE_NOTE_FILE} or ${BLOCKER_REPORT_FILE} and its report into ${label}, ${rerun}`
        }
      ]
    };
  }

  if (kind === "assessment") {
    const validation = await validateAssessment(dir, label);
    return validation.ok
      ? { ok: true, result: { kind, ...validation.result } }
      : { ok: false, kind, problems: validation.problems };
  }

  const problems: CommandError[] = [];
  await checkNoEngineOutput(dir, label, rerun, problems);
  const result =
    kind === "out-of-scope-note"
      ? await checkOutOfScopeNote(dir, label, rerun, problems)
      : await checkBlockerReport(dir, label, rerun, problems);
  return problems.length > 0 || result === null ? { ok: false, kind, problems } : { ok: true, result };
}

async function checkOutOfScopeNote(
  dir: string,
  label: string,
  rerun: string,
  problems: CommandError[]
): Promise<ValidatedOutput | null> {
  const raw = await readOptional(path.join(dir, OUT_OF_SCOPE_NOTE_FILE));
  const note =
    raw === null
      ? null
      : parseVersioned(
          raw,
          OUT_OF_SCOPE_NOTE_FILE,
          OUT_OF_SCOPE_NOTE_SCHEMA_VERSION,
          OutOfScopeNoteSchema,
          "validate_output",
          rerun,
          problems
        );
  await checkComposed(dir, label, OUT_OF_SCOPE_NOTE_REPORT, OUT_OF_SCOPE_NOTE_SECTIONS, rerun, problems);
  if (note === null) return null;
  return {
    kind: "out-of-scope-note",
    assessment_dir: label,
    note_schema_version: note.schema_version,
    evidence: note.classification.evidence.length,
    referrals: note.referrals.length
  };
}

async function checkBlockerReport(
  dir: string,
  label: string,
  rerun: string,
  problems: CommandError[]
): Promise<ValidatedOutput | null> {
  const raw = await readOptional(path.join(dir, BLOCKER_REPORT_FILE));
  const report =
    raw === null
      ? null
      : parseVersioned(
          raw,
          BLOCKER_REPORT_FILE,
          BLOCKER_REPORT_SCHEMA_VERSION,
          BlockerReportSchema,
          "validate_output",
          rerun,
          problems
        );
  if (report !== null) {
    checkGapsCover(report.not_exercised.instructions, report.not_exercised.actors, report.gaps, rerun, problems);
  }
  const markdown = await checkComposed(
    dir,
    label,
    BLOCKER_REPORT_REPORT,
    BLOCKER_REPORT_SECTIONS,
    rerun,
    problems
  );
  if (report === null) return null;

  if (markdown !== null) {
    const gapsSection = sectionBody(markdown, "Gaps");
    for (const gap of report.gaps) {
      if (!gapsSection.includes(gap.subject)) {
        problems.push({
          code: "validate_report_gap_unnamed",
          message: `${BLOCKER_REPORT_REPORT} \`## Gaps\` does not name the Gap ${JSON.stringify(gap.subject)}`,
          next: `list ${JSON.stringify(gap.subject)} with its reason and unblock under \`## Gaps\`, ${rerun}`
        });
      }
    }
  }
  return {
    kind: "blocker-report",
    assessment_dir: label,
    report_schema_version: report.schema_version,
    depth: report.depth,
    gaps: report.gaps.length
  };
}

/** Check a composed short-circuit report: required sections present and in order, no risk-surface section. */
async function checkComposed(
  dir: string,
  label: string,
  file: string,
  required: readonly string[],
  rerun: string,
  problems: CommandError[]
): Promise<string | null> {
  const markdown = await readOptional(path.join(dir, file));
  if (markdown === null) {
    problems.push({
      code: "validate_report_missing",
      message: `${file} not found in ${label}`,
      next: `compose ${file} with the ${required.map((s) => `\`## ${s}\``).join(", ")} sections, ${rerun}`
    });
    return null;
  }
  checkSections(markdown, file, required, rerun, problems);
  const headings = new Set([...markdown.matchAll(/^#{1,6} (.+?)\s*$/gm)].map((match) => match[1]!));
  for (const section of RISK_SURFACE_SECTIONS) {
    if (headings.has(section)) {
      problems.push({
        code: "validate_report_risk_surface",
        message: `${file} carries a \`${section}\` section; it must not describe a risk surface`,
        next: `remove the \`${section}\` section from ${file}, ${rerun}`
      });
    }
  }
  return markdown;
}

async function checkNoEngineOutput(
  dir: string,
  label: string,
  rerun: string,
  problems: CommandError[]
): Promise<void> {
  for (const file of ENGINE_OUTPUT_FILES) {
    if (await exists(path.join(dir, file))) {
      problems.push({
        code: "validate_engine_output_present",
        message: `${label} holds Engine Output ${file} beside an output that must not describe a risk surface`,
        next: `remove ${file} from ${label}, ${rerun}`
      });
    }
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
