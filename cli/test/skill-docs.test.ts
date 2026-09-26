import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(process.cwd(), "..");
const BUNDLE_ROOT = path.join(REPO_ROOT, "riptide-assess-skill");
const SKILL_DIR = path.join(BUNDLE_ROOT, "skill");

const STAGES = [
  "Classify",
  "Scope",
  "Setup",
  "Run",
  "Firing Check",
  "Repair",
  "Surface",
  "Report"
] as const;

const SKIPPED_DIRS = new Set([".git", "node_modules", "target", "dist", "case-studies"]);

function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, "SKILL.md must start with YAML frontmatter");
  return { frontmatter: match[1]!, body: raw.slice(match[0].length) };
}

async function findFiles(dir: string, name: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) found.push(...(await findFiles(path.join(dir, entry.name), name)));
    } else if (entry.name === name) {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

async function bundleMarkdown(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const readme = path.join(BUNDLE_ROOT, "README.md");
  files.set("README.md", await readFile(readme, "utf8"));
  for (const entry of await readdir(SKILL_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.set(`skill/${entry.name}`, await readFile(path.join(SKILL_DIR, entry.name), "utf8"));
    }
  }
  return files;
}

async function skillBody(): Promise<string> {
  return splitFrontmatter(await readFile(path.join(SKILL_DIR, "SKILL.md"), "utf8")).body;
}

test("the repo carries exactly one Skill bundle", async () => {
  const skillFiles = (await findFiles(REPO_ROOT, "SKILL.md")).map((file) =>
    path.relative(REPO_ROOT, file)
  );
  assert.deepEqual(skillFiles, [path.join("riptide-assess-skill", "skill", "SKILL.md")]);
  assert.equal(existsSync(path.join(REPO_ROOT, "skills")), false);
  assert.equal(existsSync(path.join(REPO_ROOT, "cli", "skills")), false);
});

test("the Skill defines one user command", async () => {
  const { frontmatter } = splitFrontmatter(await readFile(path.join(SKILL_DIR, "SKILL.md"), "utf8"));
  assert.match(frontmatter, /^name:\s+riptide-assess$/m);
  assert.match(frontmatter, /^description:\s+\S/m);
  assert.match(await skillBody(), /`\/riptide-assess`/);

  for (const [file, raw] of await bundleMarkdown()) {
    assert.doesNotMatch(raw, /\/riptide-(?!assess\b)[a-z]/, `${file} names another command`);
    assert.doesNotMatch(raw, /riptide-(config|narrative)\b/, `${file} names a removed skill`);
  }
});

test("SKILL.md lists the stages in order, each routed to a reference that exists", async () => {
  const body = await skillBody();
  assert.ok(body.includes(STAGES.join(" → ")), "stage list missing");

  let cursor = 0;
  for (const stage of STAGES) {
    const heading = new RegExp(`^### \\d+\\. ${stage}$`, "m");
    const match = heading.exec(body.slice(cursor));
    assert.ok(match, `stage heading for ${stage} missing or out of order`);
    cursor += match.index + match[0].length;
  }

  for (const [file, raw] of await bundleMarkdown()) {
    const dir = path.dirname(path.join(BUNDLE_ROOT, file));
    for (const [, target] of raw.matchAll(/\]\((\.{1,2}\/[^)#\s]+)/g)) {
      assert.ok(existsSync(path.resolve(dir, target!)), `${file} links to missing ${target}`);
    }
  }
});

test("the Steering Hint is the only input and every assumption lands in the Scope Declaration", async () => {
  const body = await skillBody();
  assert.match(body, /Steering Hint is the only input/);
  assert.match(body, /Scope Declaration/);
  assert.match(body, /overriding Steering Hint/);
  assert.match(body, /Depth/);
});

test("no bundle file instructs the agent to ask the user anything", async () => {
  const forbidden = [
    /\bask(s|ed|ing)?\b/i,
    /\bquestions?\b/i,
    /\bconfirm with\b/i,
    /\bwait for (the )?user\b/i,
    /\bprompt the user\b/i
  ];
  for (const [file, raw] of await bundleMarkdown()) {
    for (const pattern of forbidden) {
      assert.doesNotMatch(raw, pattern, `${file} matches ${pattern}`);
    }
  }
});

test("the core flow names no host-specific tools", async () => {
  const hostTerms =
    /\b(AskUserQuestion|TodoWrite|WebFetch|WebSearch|NotebookEdit|Claude Code|Codex|(Task|Agent|Bash|Read|Write|Edit|Grep|Glob) tool)\b/;
  for (const [file, raw] of await bundleMarkdown()) {
    if (file === "README.md") continue;
    const text = file === "skill/SKILL.md" ? splitFrontmatter(raw).body : raw;
    assert.doesNotMatch(text, hostTerms, `${file} names a host tool`);
  }
});

test("SKILL.md speaks the domain vocabulary", async () => {
  const body = await skillBody();
  for (const term of [
    "Assessment",
    "Assessment Context",
    "Engine",
    "Engine Output",
    "Workspace",
    "Internal Artifact",
    "Coverage",
    "Region Coverage",
    "Gap",
    "Blocker Report",
    "Out-of-Scope Note",
    "Economic Protocol",
    "Firing Check",
    "Floor Invariant",
    "Breach",
    "Causal Trace"
  ]) {
    assert.ok(body.includes(term), `SKILL.md does not use ${term}`);
  }
  assert.match(body, /not an audit signoff/);
});

test("the Firing Check stage reports an unchecked invariant as a Gap", async () => {
  const raw = await readFile(path.join(SKILL_DIR, "firing-check.md"), "utf8");
  assert.match(raw, /never counts as held/);
  assert.match(raw, /reported as a Gap/);
});

test("the Setup and Repair references keep the repair guidance", async () => {
  const setup = await readFile(path.join(SKILL_DIR, "setup.md"), "utf8");
  const repair = await readFile(path.join(SKILL_DIR, "repair.md"), "utf8");
  const run = await readFile(path.join(SKILL_DIR, "run-and-surface.md"), "utf8");

  assert.match(setup, /TODO-only setup is not acceptable/);
  assert.match(setup, /missing deterministic <fact> for guided-sim setup/);
  assert.match(setup, /Do not write fixture `manifest\.json`, `policies\.json`/);
  assert.match(setup, /Generic personas stay inline in the\s+adapter/);
  assert.match(setup, /no campaign TOML — the sweep lives in `Riptide\.toml`/);
  assert.match(setup, /\[\[sim\.fork\]\]/);
  assert.match(setup, /PythPriceUpdate/);
  assert.match(setup, /Preserve selected personas in the adapter/);
  assert.match(setup, /Do not rewrite the stored `\[sim\.sweep\] seeds_per_value`/);

  for (const failureClass of [
    "skill prompt gap",
    "CLI validation gap",
    "setup source fact gap",
    "setup API/tooling gap",
    "guided-sim required",
    "unsupported protocol surface",
    "case-study source/build issue"
  ]) {
    assert.ok(repair.includes(`\`${failureClass}\``), `repair.md lost ${failureClass}`);
  }
  assert.match(repair, /Keep coverage marked unavailable/);
  assert.match(repair, /Do not stop at "lint PASS"/);
  assert.match(repair, /Invariant failures are evidence, not setup failures/);

  assert.match(
    run,
    /riptide sim run \.riptide\/sim --iterations 5 --flows 20 --seed 1337 --out \.riptide\/sim\/artifacts\/smoke/
  );
  assert.match(run, /Do not run the full sweep until the one-seed smoke passes/);
});

test("the Skill drives only the merged review and readiness commands", async () => {
  for (const [name, raw] of await bundleMarkdown()) {
    assert.doesNotMatch(raw, /\briptide doctor\b/, `${name} names the removed doctor command`);
    assert.doesNotMatch(raw, /\briptide sim review\b/, `${name} names the removed sim review command`);
  }
  const body = await skillBody();
  assert.match(body, /`riptide readiness <dir> --json`/);
  assert.match(body, /`riptide review <path> --json`/);
});

test("the report reference carries the Causal Trace evidence rules", async () => {
  const report = await readFile(path.join(SKILL_DIR, "report.md"), "utf8");
  const trace = await readFile(path.join(SKILL_DIR, "causal-trace.md"), "utf8");

  assert.match(report, /Blocker Report/);
  assert.match(report, /Out-of-Scope Note/);
  assert.match(report, /replay command/);
  assert.match(trace, /riptide sim debug/);
  assert.match(trace, /Every number must be traceable/);
  assert.match(trace, /Cold-read gate/);
});

test("guided-sim docs guard coverage instead of claiming emitted coverage", async () => {
  const guided = await readFile(path.join(REPO_ROOT, "docs", "guided-sim.md"), "utf8");
  const architecture = await readFile(path.join(REPO_ROOT, "docs", "architecture.md"), "utf8");

  assert.match(guided, /Coverage \| Guarded gap/);
  assert.match(guided, /sim\.coverage\.enabled = true` fails lint/);
  assert.doesNotMatch(guided, /guided-sim coverage output is supported/i);
  assert.doesNotMatch(architecture, /guided-sim coverage output is supported/i);
});

test("repo docs name no removed skill", async () => {
  const docs = [
    "README.md",
    "CONTRIBUTING.md",
    path.join("cli", "README.md"),
    path.join("docs", "architecture.md"),
    path.join("docs", "vision.md"),
    path.join("docs", "install.md"),
    path.join("docs", "submission-package.md")
  ];
  for (const doc of docs) {
    const raw = await readFile(path.join(REPO_ROOT, doc), "utf8");
    assert.doesNotMatch(raw, /riptide-(config|narrative|adapt|harness|scenarios)\b/, `${doc} names a removed skill`);
    assert.doesNotMatch(raw, /skills\/riptide-/, `${doc} links a removed skill path`);
  }
});

test("the Report stage writes the Assessment Context and passes the validation gate before delivery", async () => {
  const body = await skillBody();
  const report = await readFile(path.join(SKILL_DIR, "report.md"), "utf8");
  const example = JSON.parse(
    await readFile(path.join(BUNDLE_ROOT, "examples", "assessment-context.json"), "utf8")
  ) as { schema_version: string };

  assert.match(body, /`riptide validate <assessment-dir> --json`/);
  assert.match(body, /Deliver only once that gate\s+passes/);

  assert.match(report, /`assessment-context\.json`/);
  assert.ok(report.includes(`"schema_version": "${example.schema_version}"`), "report.md and the example disagree on the schema version");
  assert.match(report, /riptide validate \.riptide\/assessment --json/);
  assert.match(report, /Never declare completion on a failing gate/);
  assert.match(report, /Compose only\s+after the last `riptide assess` render/);
  let cursor = 0;
  for (const section of ["Scope Declaration", "Coverage", "Gaps", "Engine Output"]) {
    const index = report.indexOf(`\`## ${section}\``, cursor);
    assert.notEqual(index, -1, `report.md does not order the \`## ${section}\` section`);
    cursor = index;
  }
});

test("SKILL.md documents the Default and Deep budgets", async () => {
  const body = await skillBody();
  assert.match(body, /^\| Default \|.*`seeds_per_value = \d+`.*\d+ repair attempts/m);
  assert.match(body, /^\| Deep \|.*`seeds_per_value = \d+`.*\d+ repair attempts/m);
});

test("the Classify stage documents the Economic Protocol evidence rules and lets unknown shapes continue", async () => {
  const body = await skillBody();
  const classify = await readFile(path.join(SKILL_DIR, "classify-and-scope.md"), "utf8");

  assert.match(body, /only positive evidence of no signal at\s+all takes it out/);
  assert.match(body, /matches no known\s+family is still in scope/);

  assert.match(classify, /^### The Economic Protocol verdict$/m);
  for (const signal of ["Pooled value", "Claims on pooled value", "Prices and rates", "Solvency conditions"]) {
    assert.ok(classify.includes(`**${signal}**`), `classify-and-scope.md lost the ${signal} signal`);
  }
  assert.match(classify, /Family\s+matching never decides it/);
  assert.match(classify, /An Out-of-Scope Note needs positive evidence/);
  assert.match(classify, /generic Economic Protocol fallback/);
  assert.match(classify, /Novelty is never a reason to\s+stop/);
  assert.match(classify, /Out-of-Scope Note is delivered about a minute/);
  assert.match(classify, /It builds nothing, runs no `riptide init`/);
});

test("the Report stage defines the Out-of-Scope Note and Blocker Report, gated and free of risk-surface claims", async () => {
  const report = await readFile(path.join(SKILL_DIR, "report.md"), "utf8");
  const examples = path.join(BUNDLE_ROOT, "examples");

  for (const [kind, sections] of [
    ["out-of-scope-note", ["Classification", "Code-Level Auditing"]],
    ["blocker-report", ["Scope Declaration", "Blocker", "Gaps"]]
  ] as const) {
    const example = JSON.parse(await readFile(path.join(examples, `${kind}.json`), "utf8")) as {
      schema_version: string;
    };
    assert.ok(report.includes(`"schema_version": "${example.schema_version}"`), `report.md and ${kind}.json disagree`);
    assert.ok(report.includes(`\`${kind}.md\``), `report.md does not name ${kind}.md`);
    assert.ok(report.includes(`riptide validate .riptide/${kind} --json`), `report.md does not gate ${kind}`);
    let cursor = report.indexOf(`\`${kind}.md\``);
    for (const section of sections) {
      const index = report.indexOf(`\`## ${section}\``, cursor);
      assert.notEqual(index, -1, `report.md does not order ${kind}'s \`## ${section}\` section`);
      cursor = index;
    }
  }

  assert.match(report, /^## No risk surface in either$/m);
  assert.match(report, /describes a risk\s+surface or makes any claim about the program's behaviour/);
  assert.match(report, /rejects an Assessment whose Coverage is zero/);
  assert.match(report, /auditor-skill/);
});
