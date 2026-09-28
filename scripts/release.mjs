#!/usr/bin/env node
// Release the Skill and the Engine together from one commit (ADR 0001).
//
//   node scripts/release.mjs check            every Version Pin agrees with the CLI version
//   node scripts/release.mjs bump <version>   move the CLI version and every Version Pin to <version>
//   node scripts/release.mjs publish [--dry-run]
//                                             preflight, test, then `npm publish` the CLI
//
// `--root <dir>` points any subcommand at another checkout; `RIPTIDE_RELEASE_NPM`
// names the npm executable to run.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NPM = process.env.RIPTIDE_RELEASE_NPM || "npm";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const CLI_PACKAGE = "cli/package.json";
const SHRINKWRAP = "cli/npm-shrinkwrap.json";
const SKILL = "riptide-assess-skill/skill/SKILL.md";
const EXAMPLES = "riptide-assess-skill/skill/examples";
const MARKETPLACE = ".claude-plugin/marketplace.json";

function fail(message) {
  process.stderr.write(`release: ${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), dryRun: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") args.root = path.resolve(argv[++i] ?? fail("--root needs a directory"));
    else if (argv[i] === "--dry-run") args.dryRun = true;
    else args.rest.push(argv[i]);
  }
  return args;
}

const read = (root, file) => readFileSync(path.join(root, file), "utf8");
const readJson = (root, file) => JSON.parse(read(root, file));
const writeJson = (root, file, value) => writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);

function exampleFiles(root) {
  return readdirSync(path.join(root, EXAMPLES))
    .filter((name) => name.endsWith(".json"))
    .map((name) => `${EXAMPLES}/${name}`);
}

function engineReferences(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return [...text.matchAll(new RegExp(`${escaped}@([^\\s\`"<>]+)`, "g"))].map((match) => match[1]);
}

/** Every place a release names a version, and the value it names there. */
function versionSites(root) {
  const sites = [];
  const pkg = readJson(root, CLI_PACKAGE);
  sites.push([`${CLI_PACKAGE} version`, pkg.version]);

  const shrinkwrap = readJson(root, SHRINKWRAP);
  sites.push([`${SHRINKWRAP} version`, shrinkwrap.version]);
  sites.push([`${SHRINKWRAP} packages[""].version`, shrinkwrap.packages?.[""]?.version]);

  const skill = read(root, SKILL);
  const pins = [...skill.matchAll(/\*\*Version Pin:\*\* `([^`]+)`/g)].map((match) => match[1]);
  if (pins.length !== 1) fail(`${SKILL} must name exactly one Version Pin, found ${pins.length}`);
  sites.push([`${SKILL} Version Pin`, pins[0]]);
  for (const ref of engineReferences(skill, pkg.name)) sites.push([`${SKILL} ${pkg.name}@`, ref]);
  for (const [, printed] of skill.matchAll(/it prints `(\d[^`]*)`/g)) sites.push([`${SKILL} Engine check`, printed]);

  for (const file of exampleFiles(root)) {
    const example = readJson(root, file);
    for (const field of ["skill_version", "engine_version"]) {
      if (field in example) sites.push([`${file} ${field}`, example[field]]);
    }
    for (const ref of engineReferences(read(root, file), pkg.name)) sites.push([`${file} ${pkg.name}@`, ref]);
  }

  const marketplace = readJson(root, MARKETPLACE);
  for (const plugin of marketplace.plugins ?? []) {
    sites.push([`${MARKETPLACE} plugins[${plugin.name}].version`, plugin.version]);
  }
  return sites;
}

function check(root) {
  const version = readJson(root, CLI_PACKAGE).version;
  const drift = versionSites(root).filter(([, value]) => value !== version);
  if (drift.length > 0) {
    fail(
      `Version Pin drift from the CLI version ${version}:\n` +
        drift.map(([site, value]) => `  ${site} = ${JSON.stringify(value)}`).join("\n") +
        `\nrun \`node scripts/release.mjs bump ${version}\``
    );
  }
  return version;
}

function bump(root, next) {
  if (!next || !SEMVER.test(next)) fail(`bump needs a semver version, got ${JSON.stringify(next ?? null)}`);
  const current = check(root);

  const pkg = readJson(root, CLI_PACKAGE);
  pkg.version = next;
  writeJson(root, CLI_PACKAGE, pkg);

  const shrinkwrap = readJson(root, SHRINKWRAP);
  shrinkwrap.version = next;
  shrinkwrap.packages[""].version = next;
  writeJson(root, SHRINKWRAP, shrinkwrap);

  const repin = (text) => text.split(`${pkg.name}@${current}`).join(`${pkg.name}@${next}`);
  writeFileSync(
    path.join(root, SKILL),
    repin(read(root, SKILL))
      .replace(`**Version Pin:** \`${current}\``, `**Version Pin:** \`${next}\``)
      .split(`it prints \`${current}\``)
      .join(`it prints \`${next}\``)
  );

  for (const file of exampleFiles(root)) {
    let text = repin(read(root, file));
    for (const field of ["skill_version", "engine_version"]) {
      text = text.split(`"${field}": "${current}"`).join(`"${field}": "${next}"`);
    }
    writeFileSync(path.join(root, file), text);
  }

  const marketplace = readJson(root, MARKETPLACE);
  for (const plugin of marketplace.plugins) plugin.version = next;
  writeJson(root, MARKETPLACE, marketplace);

  check(root);
  process.stdout.write(`release: ${current} -> ${next}; commit the bump, then run \`node scripts/release.mjs publish\`\n`);
}

function run(root, command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: options.inherit ? "inherit" : "pipe" });
}

/** The logged-in npm user must own the package's scope, directly or through the org of that name. */
function checkScope(root, name) {
  const scope = name.startsWith("@") ? name.slice(1, name.indexOf("/")) : null;
  if (scope === null) return;
  let user;
  try {
    user = run(root, NPM, ["whoami"]).trim();
  } catch {
    fail("not logged in to npm: run `npm login` first");
  }
  if (user === scope) return;
  let members = {};
  try {
    members = JSON.parse(run(root, NPM, ["org", "ls", scope, "--json"]));
  } catch {
    fail(`npm user ${user} cannot publish to the @${scope} scope: it is neither that user nor an org ${user} belongs to`);
  }
  if (!(user in members)) fail(`npm user ${user} is not a member of the @${scope} org`);
}

function publish(root, dryRun) {
  const version = check(root);
  const { name } = readJson(root, CLI_PACKAGE);

  if (!dryRun && run(root, "git", ["status", "--porcelain"]).trim() !== "") {
    fail("the working tree is not clean: publish only from the release commit");
  }
  let published = "";
  try {
    published = run(root, NPM, ["view", `${name}@${version}`, "version"]).trim();
  } catch {
    // Not on the registry yet.
  }
  if (published === version) fail(`${name}@${version} is already published: bump the version first`);
  if (!dryRun) checkScope(root, name);

  run(root, NPM, ["test"], { inherit: true });
  run(path.join(root, "cli"), NPM, ["publish", "--access", "public", ...(dryRun ? ["--dry-run"] : [])], {
    inherit: true
  });
  process.stdout.write(
    `release: ${dryRun ? "dry run of " : ""}${name}@${version} published; the Skill's Version Pin names it\n`
  );
}

const { root, dryRun, rest } = parseArgs(process.argv.slice(2));
const [command, version] = rest;
switch (command) {
  case "check":
    process.stdout.write(`release: every Version Pin names ${check(root)}\n`);
    break;
  case "bump":
    bump(root, version);
    break;
  case "publish":
    publish(root, dryRun);
    break;
  default:
    fail("usage: node scripts/release.mjs check | bump <version> | publish [--dry-run] [--root <dir>]");
}
