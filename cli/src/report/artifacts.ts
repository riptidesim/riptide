import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SimulationResult } from "../compiler/schema.js";
import { renderNarrative, type NarrativeConfig } from "./narrative.js";

export interface WriteArtifactsOptions {
  narrativeConfig?: NarrativeConfig;
}

export async function writeArtifacts(
  result: SimulationResult,
  outputPath: string,
  options: WriteArtifactsOptions = {}
): Promise<string> {
  await mkdir(outputPath, { recursive: true });
  const target = path.join(outputPath, "simulation-result.json");
  await writeFile(target, JSON.stringify(result, null, 2));

  if (options.narrativeConfig) {
    const reportPath = path.join(outputPath, "report.md");
    const narrative = renderNarrative(result, options.narrativeConfig);
    await writeFile(reportPath, narrative);
  }

  return target;
}
