// Build the React + Vite Studio frontend bundle that ships inside the
// CLI package under `cli/assets/studio/`.
//
// This script is intentionally permissive:
// - if `cli/studio-app/node_modules` is missing, it asks the user to
//   run `npm install` in `cli/studio-app/` rather than installing
//   silently from inside the CLI build (we never want a normal CLI
//   build to silently shell out to the network).
// - if the studio-app workspace is missing entirely, it logs a hint
//   and exits 0 so package builds can still use the checked-in bundle.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(scriptDir, "..");
const appRoot = path.resolve(cliRoot, "studio-app");

if (!existsSync(appRoot)) {
  console.log(`[build-studio-app] no studio-app/ workspace at ${appRoot}; skipping`);
  process.exit(0);
}

if (!existsSync(path.join(appRoot, "node_modules"))) {
  console.log(
    `[build-studio-app] studio-app dependencies not installed.` +
      `\n  Run: cd ${appRoot} && npm install` +
      `\n  Skipping the React build for now; the checked-in cli/assets/studio/ bundle remains in use.`
  );
  process.exit(0);
}

const result = spawnSync("npm", ["run", "build"], {
  cwd: appRoot,
  stdio: "inherit",
  env: process.env
});
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
