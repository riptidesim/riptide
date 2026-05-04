import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(process.cwd(), "..");

function frontmatter(raw: string): string {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, "SKILL.md must start with YAML frontmatter");
  return match[1]!;
}

test("riptide-config skill frontmatter is present and names the merged flow", async () => {
  const raw = await readFile(
    path.join(REPO_ROOT, "skills", "riptide-config", "SKILL.md"),
    "utf8"
  );
  const fm = frontmatter(raw);

  assert.match(fm, /^name:\s+riptide-config$/m);
  assert.match(fm, /^description:\s+>-/m);
  assert.match(fm, /adapter, harness, scenario, repair, and campaign/);
  assert.match(raw, /campaign_ready = yes/);
  assert.match(raw, /bounded_ready = yes/);
  assert.match(raw, /Do not stop at "lint PASS"/);
  assert.match(raw, /next steps, as a short explicit block/);
  assert.match(raw, /the exact `riptide campaign run \.\.\.` command/);
  assert.match(raw, /the exact `riptide review <campaign-root>` command/);
  assert.match(raw, /The skill prepares\s+campaign readiness; `riptide campaign run`/);
  assert.match(raw, /retained-case paths to inspect/);
  assert.match(raw, /accept the current evidence boundary or expand/);
  assert.match(raw, /default configuration path after `riptide init`/);
  assert.match(raw, /Plain\s+init intentionally creates only a thin `\.riptide\/` bootstrap/);
  assert.match(raw, /Own persona, scenario, invariant, and campaign creation by default/);
  assert.match(raw, /When the user explicitly ran `riptide init --wizard`/);
  assert.match(raw, /Preserve selected personas in the adapter/);
  assert.match(raw, /Preserve selected scenarios and existing `\.riptide\/scenarios\/\*\*\/run-config\.json`/);
  assert.match(raw, /Do not\s+rewrite the scenario's stored `seeds` value/);
  assert.match(raw, /before\/after values/);
  assert.match(raw, /preserve the user's\s+content unless validation proves it is invalid/);
  assert.match(raw, /TODO-only harness is not acceptable/);
  assert.match(raw, /missing deterministic <fact> for harness setup/);
  assert.match(raw, /harness-solvable setup gaps/);
  assert.match(raw, /engine\/runtime dispatcher gaps/);
  assert.match(raw, /dynamic\s+`remaining_accounts`/);
});

test("repo skill frontmatter blocks expose name and description", async () => {
  const skillsDir = path.join(REPO_ROOT, "skills");
  const entries = await readdir(skillsDir, { withFileTypes: true });

  for (const entry of entries.filter((item) => item.isDirectory())) {
    const raw = await readFile(path.join(skillsDir, entry.name, "SKILL.md"), "utf8");
    const fm = frontmatter(raw);
    assert.match(fm, /^name:\s+\S+/m, `${entry.name} missing name`);
    assert.match(fm, /^description:\s+/m, `${entry.name} missing description`);
  }
});

test("user-facing docs present only the current config skill", async () => {
  const removedNames = ["adapt", "harness", "scenarios"].map((name) => `riptide-${name}`);
  const docs = [
    "README.md",
    "CONTRIBUTING.md",
    path.join("docs", "architecture.md"),
    path.join("docs", "vision.md"),
    path.join("docs", "adapter-lineage.md"),
    path.join("docs", "campaigns.md"),
    path.join("docs", "install.md"),
    path.join("skills", "riptide-config", "SKILL.md")
  ];

  for (const doc of docs) {
    const raw = await readFile(path.join(REPO_ROOT, doc), "utf8");
    for (const name of removedNames) {
      assert.equal(raw.includes(name), false, `${doc} mentions ${name}`);
    }
    const aliasPhrase = ["compatibility", "alias"].join(" ");
    assert.equal(raw.includes(aliasPhrase), false, `${doc} mentions ${aliasPhrase}`);
  }
});

test("riptide-config keeps user-repo personas inline, not fixture policies", async () => {
  const prompt = await readFile(
    path.join(REPO_ROOT, "skills", "riptide-config", "SKILL.md"),
    "utf8"
  );

  assert.match(prompt, /Do not write fixture `manifest\.json`, `policies\.json`/);
  assert.match(prompt, /Generic personas stay inline in the\s+adapter/);
  assert.match(
    prompt,
    /riptide run <slug> --adapter \.riptide\/adapters\/<program>\.toml --harness \.riptide\/harness --seeds 1 --seed-root 1337/
  );
  assert.doesNotMatch(prompt, /`personas` is a list whose length equals `agents`/);
  assert.doesNotMatch(prompt, /must match policies\.json entries/);
  assert.match(prompt, /Omit `--harness` only when the adapter is proven to boot without setup/);
});
