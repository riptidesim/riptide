import {
  supportLevelDefinition,
  type ReadinessEvidence,
  type ReadinessReason,
  type ReadinessReport,
} from "./model.js";

export interface RenderReadinessMarkdownOptions {
  title?: string;
  headingLevel?: number;
}

export interface ReadinessBatchReport {
  schemaVersion: "readiness-batch.v1";
  caseStudiesRoot: string;
  reports: ReadinessReport[];
}

export function renderReadinessMarkdown(
  report: ReadinessReport,
  options: RenderReadinessMarkdownOptions = {}
): string {
  const title = options.title ?? "Riptide Readiness Report";
  const level = options.headingLevel ?? 1;
  const lines: string[] = [];
  const next = report.support.next ? supportLevelDefinition(report.support.next) : null;

  lines.push(heading(level, title));
  lines.push("");
  lines.push(`- Repository: ${repoLabel(report)}`);
  lines.push(
    `- Observed support level: ${report.support.current} - ${report.support.currentName}`
  );
  lines.push(`- Status: ${report.support.status}`);
  lines.push(`- Next level: ${next ? `${next.id} - ${next.name}` : "none"}`);
  lines.push(`- E2E evidence kind: ${report.support.e2eKind}`);
  lines.push("");

  lines.push(heading(level + 1, "Missing Inputs"));
  if (report.support.missingEvidenceForNextLevel.length === 0) {
    lines.push("- Missing inputs: none for the next support level.");
  } else {
    lines.push(
      `- Missing inputs: ${report.support.missingEvidenceForNextLevel.join(", ")}`
    );
  }
  const reasons = uniqueReasons([
    ...report.support.blockedReasons,
    ...report.support.partialReasons,
    ...report.blockers,
  ]);
  if (reasons.length === 0) {
    lines.push("- No blockers or partial reasons were reported.");
  } else {
    for (const reason of reasons) lines.push(reasonLine(reason));
  }
  lines.push("");

  lines.push(heading(level + 1, "Next Actions"));
  if (report.nextActions.length === 0) {
    lines.push("- next action: Record the observed support level and evidence paths.");
  } else {
    for (const action of report.nextActions) {
      lines.push(`- next action (${action.layer}): ${action.action}`);
    }
  }
  lines.push("");

  lines.push(heading(level + 1, "Evidence"));
  for (const evidence of report.evidence) lines.push(evidenceLine(evidence));
  lines.push("");

  lines.push(heading(level + 1, "Slices"));
  if (report.slices.length === 0) {
    lines.push("- No validated slice is present in this report.");
  } else {
    for (const slice of report.slices) {
      lines.push(
        `- ${slice.name}: ${slice.class}, observed ${slice.currentLevel}, target ${slice.supportLevelTarget}`
      );
      for (const evidence of slice.evidence) {
        lines.push(`  - ${evidenceLine(evidence).slice(2)}`);
      }
      for (const boundary of slice.boundaries) {
        lines.push(`  - boundary: ${boundary}`);
      }
    }
  }
  lines.push("");

  lines.push(heading(level + 1, "Not Currently Wired"));
  lines.push(
    "- Campaign execution is not currently wired into readiness; L7 checks input presence only."
  );
  if (report.slices.length === 0) {
    lines.push(
      "- Risk-slice coverage is not currently wired until a valid repo-local .riptide/slices/<name>.toml and matching run evidence are present."
    );
  }
  lines.push("");

  lines.push(heading(level + 1, "Boundaries"));
  if (report.boundaries.length === 0) {
    lines.push("- No additional boundaries were reported.");
  } else {
    for (const boundary of report.boundaries) {
      lines.push(`- ${boundary.scope}: ${boundary.description}`);
    }
  }
  lines.push("");

  lines.push(heading(level + 1, "Warnings"));
  if (report.warnings.length === 0) {
    lines.push("- None.");
  } else {
    for (const warning of report.warnings) lines.push(`- ${warning}`);
  }
  lines.push("");

  lines.push(heading(level + 1, "Semantic Hygiene"));
  if (report.semanticHygiene.findings.length === 0) {
    lines.push("- No semantic hygiene findings.");
  } else {
    for (const finding of report.semanticHygiene.findings) {
      lines.push(
        `- ${finding.severity}: ${finding.concept} -> ${finding.recommendedLocation}; ${finding.message}`
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export function renderReadinessBatchMarkdown(batch: ReadinessBatchReport): string {
  const lines: string[] = [];
  lines.push("# Riptide Case-Study Readiness");
  lines.push("");
  lines.push(`- Case-study root: ${batch.caseStudiesRoot}`);
  lines.push(`- Repositories inspected: ${batch.reports.length}`);
  lines.push(`- Observed support level summary: ${supportSummary(batch.reports)}`);
  lines.push("");

  for (const report of batch.reports) {
    lines.push(
      renderReadinessMarkdown(report, {
        title: report.repo.candidate ?? report.repo.path ?? "repository",
        headingLevel: 2,
      }).trimEnd()
    );
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function heading(level: number, title: string): string {
  return `${"#".repeat(Math.max(1, Math.min(level, 6)))} ${title}`;
}

function repoLabel(report: ReadinessReport): string {
  const parts = [
    report.repo.candidate ?? null,
    report.repo.path ?? null,
    report.repo.branch ? `branch ${report.repo.branch}` : null,
    report.repo.commit ? `commit ${report.repo.commit.slice(0, 12)}` : null,
  ].filter((part): part is string => part !== null && part.length > 0);
  return parts.length > 0 ? parts.join(" | ") : "unknown";
}

function reasonLine(reason: ReadinessReason): string {
  const evidence =
    reason.evidence && reason.evidence.length > 0
      ? ` Evidence: ${reason.evidence.join(", ")}.`
      : "";
  return `- ${reason.layer}: ${reason.message}${evidence}`;
}

function evidenceLine(evidence: ReadinessEvidence): string {
  const status = evidence.present ? "present" : "missing";
  const paths = evidence.paths.length > 0 ? ` Paths: ${evidence.paths.join(", ")}.` : "";
  const notes = evidence.notes.length > 0 ? ` Notes: ${evidence.notes.join("; ")}.` : "";
  return `- ${status}: ${evidence.label} (${evidence.key}).${paths}${notes}`;
}

function uniqueReasons(reasons: ReadinessReason[]): ReadinessReason[] {
  const seen = new Set<string>();
  const unique: ReadinessReason[] = [];
  for (const reason of reasons) {
    const key = `${reason.layer}\u0000${reason.code}\u0000${reason.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(reason);
  }
  return unique;
}

function supportSummary(reports: ReadinessReport[]): string {
  if (reports.length === 0) return "none";
  const counts = new Map<string, number>();
  for (const report of reports) {
    counts.set(report.support.current, (counts.get(report.support.current) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([level, count]) => `${level}=${count}`)
    .join(", ");
}
