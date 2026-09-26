import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { FAMILY_CLASS, FLOOR_INVARIANTS, type Family } from "../src/sim/floor-invariants.js";

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

test("the family library declares the Engine's Floor Invariants for every family and the generic fallback", async () => {
  const library = await readFile(path.join(SKILL_DIR, "family-library.md"), "utf8");
  const headings: Record<Family, string> = {
    lending: "## lending",
    amm: "## amm",
    perps: "## perps",
    lst: "## lst (liquid staking)",
    stablecoin: "## stablecoin",
    generic: "## custom / other — the generic Economic Protocol fallback"
  };
  for (const [family, heading] of Object.entries(headings) as Array<[Family, string]>) {
    const start = library.indexOf(`${heading}\n`);
    assert.notEqual(start, -1, `family-library.md has no ${heading} entry`);
    const end = library.indexOf("\n## ", start + 1);
    const entry = library.slice(start, end === -1 ? undefined : end);
    assert.ok(
      entry.includes(`- **Floor Invariants** (\`${FAMILY_CLASS[family]}\``),
      `${heading} does not name its Floor Invariants' class`
    );
    for (const floor of FLOOR_INVARIANTS[family]) {
      assert.ok(entry.includes(`\`${floor.id}\``), `${heading} does not declare Floor Invariant ${floor.id}`);
      assert.ok(entry.includes(`\`${floor.expr}\``), `${heading} states a different expression for ${floor.id}`);
    }
  }
});

test("the Firing Check stage checks every Floor Invariant and downgrades one that does not fire to a Gap", async () => {
  const raw = await readFile(path.join(SKILL_DIR, "firing-check.md"), "utf8");
  assert.match(raw, /`data\.floor_invariants`/);
  assert.match(raw, /downgrade it: outcome `gap`, and a Gap whose `subject` is the\s+invariant's ID/);
  assert.match(raw, /Never drop a Floor Invariant/);
  for (const field of ["`id`", "`provenance`", "`firing_check`", "`outcome`"]) {
    assert.ok(raw.includes(field), `firing-check.md does not record ${field}`);
  }
});

test("the Firing Check stage drives the Engine's firing-check mode", async () => {
  const raw = await readFile(path.join(SKILL_DIR, "firing-check.md"), "utf8");
  assert.match(raw, /riptide sim run \.riptide\/sim --firing-check .*--json/);
  assert.match(raw, /\.riptide\/sim\/src\/violations\.rs/);
  assert.doesNotMatch(raw, /Engine may not offer it/);
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
    await readFile(path.join(SKILL_DIR, "examples", "assessment-context.json"), "utf8")
  ) as { schema_version: string };

  assert.match(body, /`riptide validate <assessment-dir> --json`/);
  assert.match(body, /Deliver only once that gate\s+passes/);

  assert.match(report, /`assessment-context\.json`/);
  assert.ok(report.includes(`"schema_version": "${example.schema_version}"`), "report.md and the example disagree on the schema version");
  assert.match(report, /riptide validate \.riptide\/assessments\/001 --json/);
  assert.match(report, /Never declare completion on a failing gate/);
  assert.match(report, /Compose only\s+after the last `riptide assess` render/);
  let cursor = 0;
  for (const section of ["Scope Declaration", "Coverage", "Gaps", "Invariants", "Engine Output"]) {
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
  const examples = path.join(SKILL_DIR, "examples");

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

test("the Report stage records every Breach with its pinned replay command and a Causal Trace", async () => {
  const body = await skillBody();
  const report = await readFile(path.join(SKILL_DIR, "report.md"), "utf8");
  const trace = await readFile(path.join(SKILL_DIR, "causal-trace.md"), "utf8");
  const replay = "npx --yes @riptide/cli@<engine_version> sim debug .riptide/sim --seed <hex>";

  assert.match(body, /\[causal-trace\.md\]\(\.\/causal-trace\.md\)/);
  for (const field of ["invariant_id", "seed", "replay_command", "causal_trace"]) {
    assert.ok(report.includes(`"${field}"`), `report.md does not document the Breach field ${field}`);
  }
  assert.ok(report.includes(replay), "report.md does not give the pinned replay command");
  assert.ok(trace.includes(replay), "causal-trace.md does not give the pinned replay command");
  let cursor = 0;
  for (const section of ["Invariants", "Breaches", "Engine Output"]) {
    const index = report.indexOf(`\`## ${section}\``, cursor);
    assert.notEqual(index, -1, `report.md does not order the \`## ${section}\` section`);
    cursor = index;
  }

  assert.match(trace, /riptide sim debug \.riptide\/sim --seed <hex> --json/);
  assert.match(trace, /`\*\*T<n>\*\*`/);
  assert.doesNotMatch(trace, /not synthesized/, "the gate rejects a Breach without a Causal Trace");
  assert.match(trace, /simulation evidence/);
});

test("no Skill file words a Breach as a vulnerability", async () => {
  for (const [name, raw] of await bundleMarkdown()) {
    for (const match of raw.matchAll(/vulnerabilit(y|ies)/gi)) {
      const before = raw.slice(Math.max(0, match.index - 60), match.index);
      assert.match(before, /\b(never|not)\b/, `${name} uses "${match[0]}" outside a prohibition`);
    }
  }
});

async function cliPackage(): Promise<{ name: string; version: string }> {
  return JSON.parse(await readFile(path.join(REPO_ROOT, "cli", "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
}

/** Every file an installed Skill carries: the whole `skill/` directory. */
async function installedFiles(dir = SKILL_DIR): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) for (const [file, raw] of await installedFiles(full)) files.set(file, raw);
    else files.set(path.relative(SKILL_DIR, full), await readFile(full, "utf8"));
  }
  return files;
}

test("SKILL.md names one Version Pin, the CLI package version, and the Assessment Context records it", async () => {
  const body = await skillBody();
  const report = await readFile(path.join(SKILL_DIR, "report.md"), "utf8");
  const { version } = await cliPackage();
  const pins = [...body.matchAll(/\*\*Version Pin:\*\* `([^`]+)`/g)].map((match) => match[1]);
  assert.deepEqual(pins, [version]);
  assert.match(report, /"engine_version": "<the Version Pin>"/);
  assert.match(report, /"skill_version": "<the Version Pin>"/);
  assert.doesNotMatch(report, /this Skill's version/);
});

test("the Skill resolves the Engine only through the pinned npm package", async () => {
  const body = await skillBody();
  const { name, version } = await cliPackage();
  assert.ok(body.includes(`npx --yes ${name}@${version} <command>`), "SKILL.md does not give the pinned invocation");
  assert.match(body, /resolves the Engine only through npm at the Version Pin/);
  assert.match(body, /Never run\s+a `riptide` found on PATH/);

  for (const [file, raw] of await installedFiles()) {
    for (const [, pinned] of raw.matchAll(/@riptide\/cli@([^\s`"<>]+)/g)) {
      assert.equal(pinned, version, `${file} names Engine ${pinned}, not the Version Pin`);
    }
    for (const installer of [/\bcurl\b/, /\bwget\b/, /install\.sh/, /riptide\.run\/install/, /\bnpm (i|install) (-g|--global)\b/, /`riptide --version`/]) {
      assert.doesNotMatch(raw, installer, `${file} resolves the Engine outside the Version Pin`);
    }
    if (file.startsWith(`examples${path.sep}`) && file.endsWith(".json")) {
      const example = JSON.parse(raw) as Record<string, unknown>;
      for (const field of ["skill_version", "engine_version"]) {
        if (field in example) assert.equal(example[field], version, `${file} ${field} is not the Version Pin`);
      }
    }
  }
  assert.equal(existsSync(path.join(BUNDLE_ROOT, "install.sh")), false);
});

test("the Skill checks every prerequisite first and stops with a Blocker Report naming what is missing", async () => {
  const body = await skillBody();
  const report = await readFile(path.join(SKILL_DIR, "report.md"), "utf8");
  const { version } = await cliPackage();
  const prerequisites = body.slice(body.indexOf("### Prerequisites"), body.indexOf("### Engine commands"));

  for (const [prerequisite, check] of [
    ["`node >= 20`", "`node --version`"],
    ["`cargo`", "`cargo --version`"],
    ["`cargo-build-sbf`", "`cargo-build-sbf --version`"],
    ["the Engine", `\`npx --yes @riptide/cli@${version} --version\``]
  ]) {
    assert.ok(prerequisites.includes(`| ${prerequisite} | ${check} |`), `Prerequisites does not check ${prerequisite}`);
  }
  assert.ok(prerequisites.includes(`it prints \`${version}\``));
  assert.match(prerequisites, /stop and deliver a\s+\*\*Blocker Report\*\* that names the\s+missing piece/);
  assert.match(prerequisites, /Do not start a\s+partial run/);

  assert.match(report, /`blocker\.error` starts\s+with `prerequisite_missing`/);
  assert.match(report, /\[`\.\/examples\/blocker-report-prerequisite\.json`\]/);
});

test("every file the Skill links is installed with it", async () => {
  for (const [file, raw] of await installedFiles()) {
    if (!file.endsWith(".md")) continue;
    const dir = path.dirname(path.join(SKILL_DIR, file));
    for (const [, target] of raw.matchAll(/\]\((\.{1,2}\/[^)#\s]+)/g)) {
      const resolved = path.resolve(dir, target!);
      assert.ok(!path.relative(SKILL_DIR, resolved).startsWith(".."), `${file} links ${target}, outside the Skill`);
      assert.ok(existsSync(resolved), `${file} links to missing ${target}`);
    }
  }
});

test("the plugin marketplace manifest installs the one Skill at the CLI version", async () => {
  const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, ".claude-plugin", "marketplace.json"), "utf8")) as {
    name: string;
    owner: { name: string };
    plugins: Array<{ name: string; source: string; version: string; strict: boolean; skills: string[] }>;
  };
  const { version } = await cliPackage();
  const kebab = /^[a-z0-9]+(-[a-z0-9]+)*$/;

  assert.match(manifest.name, kebab);
  assert.ok(manifest.owner.name.length > 0);
  assert.equal(manifest.plugins.length, 1);
  const [plugin] = manifest.plugins;
  assert.match(plugin!.name, kebab);
  assert.equal(plugin!.version, version);
  assert.equal(plugin!.strict, false);
  const pluginRoot = path.resolve(REPO_ROOT, plugin!.source);
  assert.equal(pluginRoot, BUNDLE_ROOT);
  assert.deepEqual(
    plugin!.skills.map((dir) => path.resolve(pluginRoot, dir)),
    [SKILL_DIR],
    "the plugin must install exactly the canonical Skill"
  );
});

test("the release script bumps the CLI version and every Version Pin together, and publishes to npm", async () => {
  const script = path.join(REPO_ROOT, "scripts", "release.mjs");
  const release = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

  const checked = release("check");
  assert.equal(checked.status, 0, checked.stderr);

  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-release-"));
  try {
    for (const file of [
      path.join("cli", "package.json"),
      path.join("cli", "npm-shrinkwrap.json"),
      path.join(".claude-plugin", "marketplace.json")
    ]) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await cp(path.join(REPO_ROOT, file), path.join(root, file));
    }
    await cp(SKILL_DIR, path.join(root, "riptide-assess-skill", "skill"), { recursive: true });

    const bumped = release("bump", "9.8.7", "--root", root);
    assert.equal(bumped.status, 0, bumped.stderr);
    const pkg = JSON.parse(await readFile(path.join(root, "cli", "package.json"), "utf8")) as { version: string };
    assert.equal(pkg.version, "9.8.7");
    const skill = await readFile(path.join(root, "riptide-assess-skill", "skill", "SKILL.md"), "utf8");
    assert.ok(skill.includes("**Version Pin:** `9.8.7`"));
    assert.ok(skill.includes("npx --yes @riptide/cli@9.8.7 <command>"));

    await writeFile(
      path.join(root, "riptide-assess-skill", "skill", "SKILL.md"),
      skill.replace("npx --yes @riptide/cli@9.8.7 <command>", "npx --yes @riptide/cli@9.8.6 <command>")
    );
    const drifted = release("check", "--root", root);
    assert.equal(drifted.status, 1);
    assert.match(drifted.stderr, /Version Pin drift from the CLI version 9\.8\.7/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the release script publishes the CLI to npm only from a clean release commit it can publish to", async () => {
  const script = path.join(REPO_ROOT, "scripts", "release.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "riptide-publish-"));
  const log = path.join(root, "npm.log");
  const npm = path.join(root, "npm-stub.mjs");
  // Stands in for npm: logs each call; the version is unpublished, the user is NPM_STUB_USER, and no org has members.
  await writeFile(
    npm,
    [
      "#!/usr/bin/env node",
      'import { appendFileSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      `appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");`,
      'if (args[0] === "view") process.exit(1);',
      'if (args[0] === "whoami") process.stdout.write(`${process.env.NPM_STUB_USER}\\n`);',
      'if (args[0] === "org") process.exit(1);'
    ].join("\n"),
    { mode: 0o755 }
  );
  const publish = (user = "riptide") =>
    spawnSync(process.execPath, [script, "publish", "--root", path.join(root, "repo")], {
      encoding: "utf8",
      env: { ...process.env, RIPTIDE_RELEASE_NPM: npm, NPM_STUB_USER: user }
    });
  const git = (...args: string[]) => spawnSync("git", args, { cwd: path.join(root, "repo"), encoding: "utf8" });

  try {
    for (const file of [
      path.join("cli", "package.json"),
      path.join("cli", "npm-shrinkwrap.json"),
      path.join(".claude-plugin", "marketplace.json")
    ]) {
      await mkdir(path.dirname(path.join(root, "repo", file)), { recursive: true });
      await cp(path.join(REPO_ROOT, file), path.join(root, "repo", file));
    }
    await cp(SKILL_DIR, path.join(root, "repo", "riptide-assess-skill", "skill"), { recursive: true });
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.name=release", "-c", "user.email=release@example.test", "commit", "-qm", "release");

    await writeFile(path.join(root, "repo", "stray.txt"), "uncommitted");
    const dirty = publish();
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /working tree is not clean/);
    await rm(path.join(root, "repo", "stray.txt"));

    const foreign = publish("someone-else");
    assert.equal(foreign.status, 1);
    assert.match(foreign.stderr, /npm user someone-else cannot publish to the @riptide scope/);
    assert.doesNotMatch(await readFile(log, "utf8"), /^publish/m);
    await rm(log);

    const published = publish();
    assert.equal(published.status, 0, published.stderr);
    const { name, version } = await cliPackage();
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
      `view ${name}@${version} version`,
      "whoami",
      "test",
      "publish --access public"
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the reuse stage refreshes, repairs and reruns the previous region, and requires the Delta on reruns", async () => {
  const body = await skillBody();
  const reuse = await readFile(path.join(SKILL_DIR, "reuse.md"), "utf8");
  const report = await readFile(path.join(SKILL_DIR, "report.md"), "utf8");

  assert.match(body, /\[reuse\.md\]\(\.\/reuse\.md\)/);
  assert.match(body, /`riptide delta <previous-assessment-dir> <assessment-dir> --json`/);
  assert.match(body, /Delta section is\s+required on reruns/);

  assert.match(reuse, /riptide sim refresh --adapter \.riptide\/adapters\/<program>\.toml --dir \.riptide\/sim --json/);
  assert.match(reuse, /\*\*Repair broken flows\.\*\*/);
  assert.match(reuse, /\*\*Author flows only for new instructions\.\*\*/);
  assert.match(reuse, /\*\*Rerun the same region\.\*\*/);
  assert.match(reuse, /riptide delta \.riptide\/assessments\/001 \.riptide\/assessments\/002 --json/);
  assert.match(reuse, /computed by the Engine, never by the agent/);
  assert.match(reuse, /Delta section is required on reruns/);
  assert.match(reuse, /never overwritten/);

  assert.match(report, /--out \.riptide\/assessments\/001/);
  assert.match(report, /never\s+overwrite an earlier one/);
  for (const field of ["previous", "metric_moves", "gaps_opened", "gaps_closed", "new_instructions"]) {
    assert.ok(report.includes(`\`${field}\``), `report.md does not document the Delta field ${field}`);
    assert.ok(reuse.includes(`\`${field}\``), `reuse.md does not document the Delta field ${field}`);
  }
  let cursor = 0;
  for (const section of ["Invariants", "Breaches", "Delta", "Engine Output"]) {
    const index = report.indexOf(`\`## ${section}\``, cursor);
    assert.notEqual(index, -1, `report.md does not order the \`## ${section}\` section`);
    cursor = index;
  }
});
