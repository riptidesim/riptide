import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(scriptDir, "..");
const sourceDir = path.join(cliRoot, "src", "compiler", "personas");
const targetDir = path.join(cliRoot, "dist", "src", "compiler", "personas");

await rm(targetDir, { recursive: true, force: true });
await cp(sourceDir, targetDir, { recursive: true, force: true });
