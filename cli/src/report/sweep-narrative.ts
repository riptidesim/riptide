import type { SweepSummary } from "../run/sweep-summary.js";

export function renderSweepNarrative(summary: SweepSummary): string {
  const lines: string[] = [];
  lines.push("# Riptide Sweep Report");
  lines.push("");
  lines.push("## Sweep metadata");
  lines.push("");
  lines.push(`- **Scenario**: ${summary.scenario}`);
  lines.push(`- **Status**: ${summary.status}`);
  lines.push(`- **Seed root**: ${summary.seed_root}`);
  lines.push(`- **Sweep size**: ${summary.sweep_size}`);
  lines.push(`- **Completed cells**: ${summary.completed}`);
  lines.push(`- **Fail-fast**: ${summary.fail_fast ? "true" : "false"}`);
  lines.push(`- **Wall clock**: ${summary.wall_clock_s.toFixed(3)}s`);
  if (summary.first_fire_cell) {
    lines.push(`- **First fire cell**: \`${summary.first_fire_cell}\``);
  }
  lines.push("");

  lines.push("## Invariant fire frequency");
  lines.push("");
  const frequencies = Object.entries(summary.invariant_fire_frequency).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  if (frequencies.length === 0) {
    lines.push("No invariant fires observed in completed cells.");
  } else {
    lines.push("| Invariant | Count | Rate |");
    lines.push("|-----------|------:|-----:|");
    for (const [name, row] of frequencies) {
      lines.push(`| ${name} | ${row.count} | ${row.rate.toFixed(4)} |`);
    }
  }
  lines.push("");

  lines.push("## Cells");
  lines.push("");
  lines.push("| Seed | Status | Wall clock | Fires |");
  lines.push("|-----:|--------|-----------:|-------|");
  for (const cell of summary.cells) {
    const fires = cell.invariant_fires.length > 0 ? cell.invariant_fires.join(", ") : "none";
    lines.push(`| ${cell.seed} | ${cell.status} | ${cell.wall_s.toFixed(3)}s | ${fires} |`);
  }
  lines.push("");

  return lines.join("\n");
}
