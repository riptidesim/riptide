import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(scriptDir, "..");
const sourceDir = path.join(cliRoot, "src", "compiler", "personas");
const targetDir = path.join(cliRoot, "dist", "src", "compiler", "personas");

await rm(targetDir, { recursive: true, force: true });
await cp(sourceDir, targetDir, { recursive: true, force: true });

// Sprint 6 T07 — copy the web dashboard assets (HTML template) into
// dist/assets/ so `startDashboardServer()` can locate them both when
// running from the compiled dist layout and when running from source
// in-tree. The server probes both <dist>/../assets and <dist>/assets,
// so either works; mirroring into dist lets a packaged CLI ship with
// the template alongside its own js.
const assetSourceDir = path.join(cliRoot, "assets");
const assetTargetDir = path.join(cliRoot, "dist", "assets");
await rm(assetTargetDir, { recursive: true, force: true });
await cp(assetSourceDir, assetTargetDir, { recursive: true, force: true });
