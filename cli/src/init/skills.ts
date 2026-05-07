// Install bundled Claude Code skills into a project's .claude/skills/.
//
// The CLI ships skill files under cli/skills/ at source time and
// scripts/copy-personas.mjs mirrors them into dist/skills/ for the
// packaged build. At runtime we resolve the bundle by walking up from
// import.meta.url, so this works in both layouts:
//   dev:  cli/src/init/skills.ts          → cli/skills/
//   built: cli/dist/src/init/skills.js    → cli/dist/skills/
//
// Existing project-level skill files are preserved unless `force` is
// set, so re-running `riptide init` against a configured project does
// not silently overwrite a user's local edits.

import { cp, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUNDLED_SKILLS = ["riptide-config"] as const;

export type BundledSkill = (typeof BUNDLED_SKILLS)[number];

export interface InstallSkillsResult {
  installed: string[];
  skipped: string[];
}

export async function installBundledSkills(input: {
  cwd: string;
  force?: boolean;
  skills?: readonly BundledSkill[];
}): Promise<InstallSkillsResult> {
  const skills = input.skills ?? BUNDLED_SKILLS;
  const targetRoot = path.join(input.cwd, ".claude", "skills");
  await mkdir(targetRoot, { recursive: true });

  const installed: string[] = [];
  const skipped: string[] = [];

  for (const skill of skills) {
    const sourceDir = await resolveBundledSkillDir(skill);
    if (!sourceDir) {
      skipped.push(skill);
      continue;
    }
    const destDir = path.join(targetRoot, skill);
    if (!input.force && (await pathExists(destDir))) {
      skipped.push(skill);
      continue;
    }
    await cp(sourceDir, destDir, { recursive: true, force: input.force === true });
    installed.push(path.join(".claude", "skills", skill));
  }

  return { installed, skipped };
}

async function resolveBundledSkillDir(skill: string): Promise<string | null> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Possible locations:
  //   dev:    cli/src/init/skills.ts        →  cli/skills/<name>
  //   built:  cli/dist/src/init/skills.js   →  cli/dist/skills/<name>
  //   pkg:    @riptide/cli/dist/src/init/   →  @riptide/cli/dist/skills/<name>
  const candidates = [
    path.resolve(here, "..", "..", "..", "skills", skill),
    path.resolve(here, "..", "..", "skills", skill),
    path.resolve(here, "..", "skills", skill)
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
