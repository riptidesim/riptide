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
  assert.match(fm, /adapter, guided-sim setup, sweep, repair, and assessment/);
  assert.match(raw, /campaign_ready = yes/);
  assert.match(raw, /bounded_ready = yes/);
  assert.match(raw, /Do not stop at "lint PASS"/);
  assert.match(raw, /next steps, as a short explicit block/);
  assert.match(raw, /the exact `riptide sim run \.\.\.` command/);
  assert.match(raw, /the exact `riptide review <guided-sim-root>` command/);
  assert.match(raw, /The skill prepares the guided-sim\s+evidence/);
  assert.match(raw, /retained-case paths to inspect/);
  assert.match(raw, /accept the current evidence boundary or expand/);
  assert.match(raw, /default configuration path after `riptide init`/);
  assert.match(raw, /Plain\s+init intentionally creates only a thin `\.riptide\/` bootstrap/);
  assert.match(raw, /Own adapter, persona, flow, sweep, and invariant authoring by default/);
  assert.match(raw, /When the user explicitly ran `riptide init --wizard`/);
  assert.match(raw, /Preserve selected personas in the adapter/);
  assert.match(raw, /Preserve selected flow emphasis and existing `\.riptide\/sim\/Riptide\.toml`/);
  assert.match(raw, /Do not rewrite the stored `\[sim\.sweep\] seeds_per_value`/);
  assert.match(raw, /before\/after values/);
  assert.match(raw, /preserve the user's\s+content unless validation proves it is invalid/);
  assert.match(raw, /TODO-only setup is not acceptable/);
  assert.match(raw, /missing deterministic <fact> for guided-sim setup/);
  assert.match(raw, /setup-solvable gaps/);
  assert.match(raw, /`riptide sim generate`/);
  assert.match(raw, /Guided Sim Stage/);
  assert.match(raw, /guided-sim loop/);
  assert.match(raw, /\.riptide\/sim\/Riptide\.toml/);
  assert.match(raw, /\[\[sim\.fork\]\]/);
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
    /riptide sim run \.riptide\/sim --flows 20 --out \.riptide\/sim\/artifacts\/<run>/
  );
  assert.doesNotMatch(prompt, /`personas` is a list whose length equals `agents`/);
  assert.doesNotMatch(prompt, /must match policies\.json entries/);
  assert.match(prompt, /Do not run the full sweep until this one-seed smoke passes/);
});

test("guided-sim docs guard coverage instead of claiming emitted coverage", async () => {
  const guided = await readFile(path.join(REPO_ROOT, "docs", "guided-sim.md"), "utf8");
  const architecture = await readFile(path.join(REPO_ROOT, "docs", "architecture.md"), "utf8");

  assert.match(guided, /Coverage \| Guarded gap/);
  assert.match(guided, /sim\.coverage\.enabled = true` fails lint/);
  assert.doesNotMatch(guided, /guided-sim coverage output is supported/i);
  assert.doesNotMatch(architecture, /guided-sim coverage output is supported/i);
});

test("riptide-config skill sim guidance includes artifact review boundary", async () => {
  const prompt = await readFile(
    path.join(REPO_ROOT, "skills", "riptide-config", "SKILL.md"),
    "utf8"
  );
  const guided = await readFile(path.join(REPO_ROOT, "docs", "guided-sim.md"), "utf8");

  assert.match(prompt, /riptide sim run \.riptide\/sim --iterations 5 --flows 20 --seed 1337 --out \.riptide\/sim\/artifacts\/smoke/);
  assert.match(prompt, /riptide sim review \.riptide\/sim\/artifacts\/smoke/);
  assert.match(prompt, /retained failing\s+seed, flow table, labelled transaction outcomes/);
  assert.match(prompt, /no campaign TOML — the sweep lives in `Riptide\.toml`/);
  assert.match(prompt, /Keep coverage marked unavailable/);
  assert.match(guided, /Review integration \| Supported for guided artifacts/);
});
