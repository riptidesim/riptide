import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

export const SweepCellStatusSchema = z.enum([
  "pass",
  "fired",
  "engine_error",
  "killed"
]);

export const SweepStatusSchema = z.enum(["all_pass", "fired", "engine_error", "interrupted"]);

export const SweepCellSummarySchema = z.object({
  seed: z.number().int().nonnegative(),
  status: SweepCellStatusSchema,
  wall_s: z.number().nonnegative(),
  invariant_fires: z.array(z.string()),
  cell_dir: z.string().min(1),
  error: z.string().min(1).optional()
});

export const SweepSummarySchema = z.object({
  scenario: z.string().min(1),
  seed_root: z.number().int().nonnegative(),
  sweep_size: z.number().int().positive(),
  completed: z.number().int().nonnegative(),
  fired: z.number().int().nonnegative(),
  engine_errors: z.number().int().nonnegative(),
  status: SweepStatusSchema,
  fail_fast: z.boolean(),
  first_fire_cell: z.string().min(1).optional(),
  wall_clock_s: z.number().nonnegative(),
  invariant_fire_frequency: z.record(
    z.string(),
    z.object({
      count: z.number().int().nonnegative(),
      rate: z.number().nonnegative()
    })
  ),
  cells: z.array(SweepCellSummarySchema)
});

export type SweepCellStatus = z.infer<typeof SweepCellStatusSchema>;
export type SweepStatus = z.infer<typeof SweepStatusSchema>;
export type SweepCellSummary = z.infer<typeof SweepCellSummarySchema>;
export type SweepSummary = z.infer<typeof SweepSummarySchema>;

export async function writeSweepSummary(
  outputDir: string,
  summary: SweepSummary
): Promise<string> {
  const parsed = SweepSummarySchema.parse(summary);
  await mkdir(outputDir, { recursive: true });
  const target = path.join(outputDir, "sweep-summary.json");
  await writeFile(target, JSON.stringify(parsed, null, 2) + "\n", "utf8");
  return target;
}
