import { cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(cliRoot, "..");
const sourceDir = path.join(cliRoot, "src", "compiler", "personas");
const targetDir = path.join(cliRoot, "dist", "src", "compiler", "personas");

await rm(targetDir, { recursive: true, force: true });
await cp(sourceDir, targetDir, { recursive: true, force: true });

// copy the web dashboard assets (HTML template) into
// dist/assets/ so `startDashboardServer()` can locate them both when
// running from the compiled dist layout and when running from source
// in-tree. The server probes both <dist>/../assets and <dist>/assets,
// so either works; mirroring into dist lets a packaged CLI ship with
// the template alongside its own js.
const assetSourceDir = path.join(cliRoot, "assets");
const assetTargetDir = path.join(cliRoot, "dist", "assets");
await rm(assetTargetDir, { recursive: true, force: true });
await cp(assetSourceDir, assetTargetDir, { recursive: true, force: true });

// Bundled Claude Code skills that `riptide init` installs into a project's
// `.claude/skills/` so users get the same configuration UX on `git clone`
// without depending on a global skill installation.
const skillsSourceDir = path.join(cliRoot, "skills");
const skillsTargetDir = path.join(cliRoot, "dist", "skills");
await rm(skillsTargetDir, { recursive: true, force: true });
await cp(skillsSourceDir, skillsTargetDir, { recursive: true, force: true });

// Guided simulations generate a Rust crate that depends on riptide-sim.
// The Rust crates are not published to crates.io yet, so packaged CLI
// installs must carry a small vendored copy for generated Cargo.toml
// path dependencies.
const simRuntimeTarget = path.join(cliRoot, "dist", "sim-runtime");
await rm(simRuntimeTarget, { recursive: true, force: true });
for (const crate of ["riptide-sim", "riptide-sim-macros"]) {
  await cp(path.join(repoRoot, crate), path.join(simRuntimeTarget, crate), {
    recursive: true,
    force: true,
    filter: (src) => !path.relative(repoRoot, src).split(path.sep).includes("target")
  });
}
await cp(path.join(repoRoot, "Cargo.lock"), path.join(simRuntimeTarget, "Cargo.lock"));
