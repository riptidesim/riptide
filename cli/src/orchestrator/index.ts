import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Derive the monorepo root from *this file's* real location on disk. The
// CLI ships as `<monorepo>/cli/dist/src/orchestrator/index.js`, so five
// dirname steps land on the monorepo root regardless of where the user
// invoked `riptide` from. `realpathSync` follows `npm link` symlinks so
// a globally-linked CLI still resolves back into the source tree.
//
// This is the fix for the "any Claude Code session / zero setup" promise:
// previously we only looked at $cwd-relative layouts, which broke the
// moment the user ran the command from anywhere outside the monorepo.
let cachedMonorepoRoot: string | undefined;
export function monorepoRootFromModule(): string | undefined {
  if (cachedMonorepoRoot !== undefined) {
    return cachedMonorepoRoot || undefined;
  }
  try {
    const here = realpathSync(fileURLToPath(import.meta.url));
    // here = <monorepo>/cli/dist/src/orchestrator/index.js
    // ^5^ ^4^ ^3^ ^2^ ^1^
    const root = path.resolve(here, "..", "..", "..", "..", "..");
    cachedMonorepoRoot = root;
    return root;
  } catch {
    cachedMonorepoRoot = "";
    return undefined;
  }
}

// npm-published installations land the compiled CLI at
// <pkg-root>/dist/src/orchestrator/index.js. Four dirname steps up is
// the package root.
//
// This is distinct from `monorepoRootFromModule` — in monorepo runs
// the pkg root is `<monorepo>/cli`.
let cachedPkgRoot: string | undefined;
export function cliPackageRootFromModule(): string | undefined {
  if (cachedPkgRoot !== undefined) {
    return cachedPkgRoot || undefined;
  }
  try {
    const here = realpathSync(fileURLToPath(import.meta.url));
    // here = <pkg-root>/dist/src/orchestrator/index.js
    // ^4^ ^3^ ^2^ ^1^
    const root = path.resolve(here, "..", "..", "..", "..");
    cachedPkgRoot = root;
    return root;
  } catch {
    cachedPkgRoot = "";
    return undefined;
  }
}
