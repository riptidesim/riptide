import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const testDir = path.resolve("dist", "test");
const testFiles = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => path.join(testDir, name));

const filterWords = process.argv.slice(2).filter((word) => word.trim().length > 0);
const args = ["--test"];
if (filterWords.length > 0) {
  args.push("--test-name-pattern", filterWords.map(escapeRegex).join(".*"));
}
args.push(...testFiles);

const env = { ...process.env };
env.RIPTIDE_REGISTRY_HOME ??= mkdtempSync(path.join(os.tmpdir(), "riptide-test-registry-"));

const result = spawnSync(process.execPath, args, { stdio: "inherit", env });
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
