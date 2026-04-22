import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SimulationResult } from "../compiler/schema.js";
import { readRawJsonSlot } from "../orchestrator/index.js";
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
  // Prefer the engine-emitted bytes verbatim when the orchestrator
  // captured them. JSON.stringify on a parsed JS value collapses
  // `500.0` to `500`, which drifts the canonical hash surfaced by
  // the Sprint 12 pack. The orchestrator stashes the raw JSON on a
  // symbol-keyed slot for exactly this reason.
  const rawJson = readRawJsonSlot(result);
  if (rawJson !== undefined) {
    await writeFile(target, rawJson);
  } else {
    await writeFile(target, JSON.stringify(result, null, 2));
  }

  if (options.narrativeConfig) {
    const reportPath = path.join(outputPath, "report.md");
    const narrative = renderNarrative(result, options.narrativeConfig);
    await writeFile(reportPath, narrative);
  }

  return target;
}
