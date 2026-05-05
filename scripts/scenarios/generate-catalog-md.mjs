#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROTOCOL_CLASSES = [
  "lending",
  "stablecoin",
  "liquid-staking",
  "perpetuals",
  "amm"
];

const CLAIM_LEVELS = ["smoke-shape", "stress", "failure-shape"];

const CLAIM_LEVEL_DESCRIPTIONS = {
  "smoke-shape":
    "deterministic and runnable; no declared invariant fires, so the fixture exercises shape only",
  stress:
    "at least one declared invariant fires under at least one parameter point; no canonical replay artifact yet",
  "failure-shape":
    "reproduces a failure-shape target with declared invariants firing at named ticks"
};

const CLASS_LABELS = {
  lending: "Lending",
  stablecoin: "Stablecoin",
  "liquid-staking": "Liquid Staking",
  perpetuals: "Perpetuals",
  amm: "AMM"
};

const EXPECTED_FAMILIES_PER_CLASS = 5;

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const repoRoot = path.resolve(scriptDir, "../..");
const requireFromCli = createRequire(path.join(repoRoot, "cli", "package.json"));
const TOML = requireFromCli("toml");

const catalogPath = path.join(repoRoot, "fixtures/scenarios/catalog.toml");
const markdownPath = path.join(repoRoot, "docs/scenario-catalog.md");

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

async function main() {
  const raw = await readFile(catalogPath, "utf8");
  const catalog = TOML.parse(raw);
  validateCatalog(catalog);
  const markdown = renderScenarioCatalogMarkdown(catalog, {
    presentationArtifacts: discoverPresentationArtifacts(repoRoot)
  });
  await mkdir(path.dirname(markdownPath), { recursive: true });
  await writeFile(markdownPath, markdown, "utf8");
  console.log(`Wrote ${path.relative(repoRoot, markdownPath)}.`);
}

function validateCatalog(catalog) {
  if (!catalog || typeof catalog !== "object") {
    throw new Error("catalog.toml must parse to an object");
  }
  if (!catalog.meta || catalog.meta.version !== 1) {
    throw new Error("catalog.toml [meta].version must be 1");
  }
  if (!Array.isArray(catalog.family)) {
    throw new Error("catalog.toml must contain [[family]] entries");
  }
}

function renderScenarioCatalogMarkdown(catalog, options = {}) {
  const lines = [];
  const families = sortFamilies(catalog.family);
  const byClass = new Map();
  for (const protocolClass of PROTOCOL_CLASSES) {
    byClass.set(
      protocolClass,
      families.filter((family) => family.class === protocolClass)
    );
  }

  lines.push("# Riptide Scenario Family Catalog");
  lines.push("");
  lines.push("Source of truth: `fixtures/scenarios/catalog.toml`.");
  lines.push("");
  lines.push(
    "The public matrix targets a 5x5 catalog: five canonical family slugs for each protocol class. Entries below are sorted by class order, then family slug."
  );
  lines.push("");
  lines.push("## Matrix");
  lines.push("");
  lines.push("| Class | Count | Target | Families |");
  lines.push("|---|---:|---:|---|");
  for (const protocolClass of PROTOCOL_CLASSES) {
    const rows = byClass.get(protocolClass) ?? [];
    const familyList =
      rows.length > 0
        ? rows.map((family) => `\`${family.slug}\``).join("<br>")
        : "";
    lines.push(
      `| ${CLASS_LABELS[protocolClass]} | ${rows.length} | ${EXPECTED_FAMILIES_PER_CLASS} | ${familyList} |`
    );
  }
  lines.push("");
  lines.push("## Claim Levels");
  lines.push("");
  for (const claimLevel of CLAIM_LEVELS) {
    lines.push(`- \`${claimLevel}\`: ${CLAIM_LEVEL_DESCRIPTIONS[claimLevel]}.`);
  }
  lines.push("");

  for (const protocolClass of PROTOCOL_CLASSES) {
    const rows = byClass.get(protocolClass) ?? [];
    lines.push(`## ${CLASS_LABELS[protocolClass]}`);
    lines.push("");
    lines.push("| Family | Name | Claim | Fixture | Result hash | Notes |");
    lines.push("|---|---|---|---|---|---|");
    for (const family of rows) {
      lines.push(
        [
          `\`${family.slug}\``,
          escapeTableCell(family.name),
          `\`${family.claim_level}\``,
          `\`${family.fixture_path}\``,
          `\`${family.result_hash}\``,
          escapeTableCell(family.notes ?? "")
        ].join(" | ").replace(/^/, "| ").replace(/$/, " |")
      );
    }
    lines.push("");
  }

  const artifacts = options.presentationArtifacts ?? [];
  if (artifacts.length > 0) {
    lines.push("## Presentation Artifacts");
    lines.push("");
    for (const artifact of artifacts) {
      lines.push(
        `- \`${artifact.path}\` is derived from \`${artifact.derivedFrom}\` and is not a counted scenario family.`
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function sortFamilies(families) {
  const classIndex = new Map(PROTOCOL_CLASSES.map((value, index) => [value, index]));
  return [...families].sort((a, b) => {
    const classOrder =
      (classIndex.get(a.class) ?? Number.MAX_SAFE_INTEGER) -
      (classIndex.get(b.class) ?? Number.MAX_SAFE_INTEGER);
    if (classOrder !== 0) return classOrder;
    return a.slug.localeCompare(b.slug);
  });
}

function discoverPresentationArtifacts(root) {
  const heroGridPath = "fixtures/analysis/lending/hero-grid/";
  if (!existsSync(path.join(root, heroGridPath))) {
    return [];
  }
  return [
    {
      path: heroGridPath,
      derivedFrom: "lending/whale-shock-grid"
    }
  ];
}

function escapeTableCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}
