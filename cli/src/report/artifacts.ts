import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SimulationResult } from "../compiler/schema.js";

export async function writeArtifacts(result: SimulationResult, outputPath: string): Promise<string> {
  await mkdir(outputPath, { recursive: true });
  const target = path.join(outputPath, "simulation-result.json");
  await writeFile(target, JSON.stringify(result, null, 2));
  return target;
}
