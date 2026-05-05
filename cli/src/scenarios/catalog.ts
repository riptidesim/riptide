import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import TOML from "toml";
import { z } from "zod";

export const SCENARIO_CATALOG_VERSION = 1;

export const PROTOCOL_CLASSES = [
  "lending",
  "stablecoin",
  "liquid-staking",
  "perpetuals",
  "amm"
] as const;

export const CLAIM_LEVELS = [
  "smoke-shape",
  "stress",
  "failure-shape"
] as const;

export const CLAIM_LEVEL_DESCRIPTIONS: Record<ClaimLevel, string> = {
  "smoke-shape":
    "deterministic and runnable; no declared invariant fires, so the fixture exercises shape only",
  stress:
    "at least one declared invariant fires under at least one parameter point; no canonical replay artifact yet",
  "failure-shape":
    "reproduces a failure-shape target with declared invariants firing at named ticks"
};

export const DEFAULT_STRICT_CLASS_COUNTS = true;
export const DEFAULT_STRICT_CLASS_COUNT_CLASSES = ["lending"] as const;
export const DEFAULT_EXPECTED_FAMILIES_PER_CLASS = 5;

export type ProtocolClass = (typeof PROTOCOL_CLASSES)[number];
export type ClaimLevel = (typeof CLAIM_LEVELS)[number];

export interface ScenarioFamily {
  slug: string;
  class: ProtocolClass;
  name: string;
  summary: string;
  fixture_path: string;
  claim_level: ClaimLevel;
  result_hash: string;
  notes?: string;
}

export interface ScenarioCatalog {
  meta: { version: typeof SCENARIO_CATALOG_VERSION };
  family: ScenarioFamily[];
}

export type CatalogDiagnosticCode =
  | "catalog_parse_error"
  | "duplicate_slug"
  | "duplicate_family_slug"
  | "slug_class_mismatch"
  | "fixture_path_mismatch"
  | "missing_fixture"
  | "catalogless_fixture"
  | "missing_result_artifact"
  | "result_hash_mismatch"
  | "class_count_mismatch"
  | "stale_markdown";

export interface CatalogDiagnostic {
  code: CatalogDiagnosticCode;
  message: string;
  slug?: string;
  path?: string;
}

export interface LintScenarioCatalogOptions {
  repoRoot: string;
  catalogPath?: string;
  markdownPath?: string;
  strictClassCounts?: boolean;
  strictClassCountClasses?: readonly ProtocolClass[];
  expectedFamiliesPerClass?: number;
  requireResultArtifacts?: boolean;
  checkGeneratedMarkdown?: boolean;
}

const FamilySchema = z
  .object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/),
    class: z.enum(PROTOCOL_CLASSES),
    name: z.string().min(1),
    summary: z.string().min(1),
    fixture_path: z.string().min(1),
    claim_level: z.enum(CLAIM_LEVELS),
    result_hash: z.string().regex(/^[a-f0-9]{64}$/),
    notes: z.string().min(1).optional()
  })
  .strict();

const CatalogSchema = z
  .object({
    meta: z
      .object({
        version: z.literal(SCENARIO_CATALOG_VERSION)
      })
      .strict(),
    family: z.array(FamilySchema)
  })
  .strict();

export async function loadScenarioCatalog(
  catalogPath: string
): Promise<ScenarioCatalog> {
  const raw = await readFile(catalogPath, "utf8");
  return parseScenarioCatalogToml(raw, catalogPath);
}

export function parseScenarioCatalogToml(
  raw: string,
  catalogPath = "fixtures/scenarios/catalog.toml"
): ScenarioCatalog {
  let parsed: unknown;
  try {
    parsed = TOML.parse(raw);
  } catch (err) {
    throw new Error(`${catalogPath}: invalid TOML: ${errMessage(err)}`);
  }

  const result = CatalogSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const loc = first?.path?.length ? first.path.join(".") : "<root>";
    const msg = first?.message ?? "schema mismatch";
    throw new Error(`${catalogPath}: ${loc}: ${msg}`);
  }
  return result.data;
}

export async function lintScenarioCatalog(
  options: LintScenarioCatalogOptions
): Promise<CatalogDiagnostic[]> {
  const repoRoot = path.resolve(options.repoRoot);
  const catalogPath =
    options.catalogPath ?? path.join(repoRoot, "fixtures/scenarios/catalog.toml");
  const markdownPath =
    options.markdownPath ?? path.join(repoRoot, "docs/scenario-catalog.md");
  const diagnostics: CatalogDiagnostic[] = [];
  let catalog: ScenarioCatalog;

  try {
    catalog = await loadScenarioCatalog(catalogPath);
  } catch (err) {
    return [
      {
        code: "catalog_parse_error",
        path: catalogPath,
        message: errMessage(err)
      }
    ];
  }

  diagnostics.push(...catalogShapeDiagnostics(catalog));

  const bySlug = new Map(catalog.family.map((family) => [family.slug, family]));
  for (const family of catalog.family) {
    const fixturePath = path.join(repoRoot, family.fixture_path);
    const runConfigPath = path.join(fixturePath, "run-config.json");
    if (!existsSync(fixturePath) || !existsSync(runConfigPath)) {
      diagnostics.push({
        code: "missing_fixture",
        slug: family.slug,
        path: family.fixture_path,
        message: `${family.slug} points at missing fixture run-config: ${path.relative(
          repoRoot,
          runConfigPath
        )}`
      });
      continue;
    }

    const resultPath = path.join(fixturePath, "simulation-result.json");
    if (existsSync(resultPath)) {
      const actualHash = await sha256File(resultPath);
      if (actualHash !== family.result_hash) {
        diagnostics.push({
          code: "result_hash_mismatch",
          slug: family.slug,
          path: path.relative(repoRoot, resultPath),
          message: `${family.slug} result_hash mismatch: catalog=${family.result_hash} actual=${actualHash}`
        });
      }
    } else if (options.requireResultArtifacts !== false) {
      diagnostics.push({
        code: "missing_result_artifact",
        slug: family.slug,
        path: path.relative(repoRoot, resultPath),
        message: `${family.slug} is missing simulation-result.json for result_hash verification`
      });
    }
  }

  for (const discovered of await discoverProtocolScenarioFixtures(repoRoot)) {
    if (!bySlug.has(discovered.slug)) {
      diagnostics.push({
        code: "catalogless_fixture",
        slug: discovered.slug,
        path: discovered.fixturePath,
        message: `${discovered.slug} has run-config.json under fixtures/scenarios but no catalog entry`
      });
    }
  }

  if (options.strictClassCounts ?? DEFAULT_STRICT_CLASS_COUNTS) {
    const expected =
      options.expectedFamiliesPerClass ?? DEFAULT_EXPECTED_FAMILIES_PER_CLASS;
    const strictClasses =
      options.strictClassCountClasses ?? DEFAULT_STRICT_CLASS_COUNT_CLASSES;
    for (const protocolClass of strictClasses) {
      const count = catalog.family.filter(
        (family) => family.class === protocolClass
      ).length;
      if (count !== expected) {
        diagnostics.push({
          code: "class_count_mismatch",
          message: `${protocolClass} has ${count} catalog family entries; expected ${expected}`
        });
      }
    }
  }

  if (options.checkGeneratedMarkdown !== false) {
    const expected = renderScenarioCatalogMarkdown(catalog, {
      presentationArtifacts: discoverPresentationArtifacts(repoRoot)
    });
    let actual = "";
    try {
      actual = await readFile(markdownPath, "utf8");
    } catch {
      diagnostics.push({
        code: "stale_markdown",
        path: path.relative(repoRoot, markdownPath),
        message: `${path.relative(repoRoot, markdownPath)} is missing; run node scripts/scenarios/generate-catalog-md.mjs`
      });
    }
    if (actual && actual !== expected) {
      diagnostics.push({
        code: "stale_markdown",
        path: path.relative(repoRoot, markdownPath),
        message: `${path.relative(repoRoot, markdownPath)} is stale; run node scripts/scenarios/generate-catalog-md.mjs`
      });
    }
  }

  return diagnostics;
}

export function renderScenarioCatalogMarkdown(
  catalog: ScenarioCatalog,
  options: { presentationArtifacts?: PresentationArtifact[] } = {}
): string {
  const lines: string[] = [];
  const families = sortFamilies(catalog.family);
  const byClass = new Map<ProtocolClass, ScenarioFamily[]>();
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
      `| ${CLASS_LABELS[protocolClass]} | ${rows.length} | ${DEFAULT_EXPECTED_FAMILIES_PER_CLASS} | ${familyList} |`
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

export function sortFamilies(families: readonly ScenarioFamily[]): ScenarioFamily[] {
  const classIndex = new Map(PROTOCOL_CLASSES.map((value, index) => [value, index]));
  return [...families].sort((a, b) => {
    const classOrder =
      (classIndex.get(a.class) ?? Number.MAX_SAFE_INTEGER) -
      (classIndex.get(b.class) ?? Number.MAX_SAFE_INTEGER);
    if (classOrder !== 0) return classOrder;
    return a.slug.localeCompare(b.slug);
  });
}

interface DiscoveredFixture {
  slug: string;
  fixturePath: string;
}

interface PresentationArtifact {
  path: string;
  derivedFrom: string;
}

async function discoverProtocolScenarioFixtures(
  repoRoot: string
): Promise<DiscoveredFixture[]> {
  const fixtures: DiscoveredFixture[] = [];
  const scenariosRoot = path.join(repoRoot, "fixtures/scenarios");
  for (const protocolClass of PROTOCOL_CLASSES) {
    const classDir = path.join(scenariosRoot, protocolClass);
    if (!existsSync(classDir)) continue;
    const entries = await readdir(classDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runConfigPath = path.join(classDir, entry.name, "run-config.json");
      if (!existsSync(runConfigPath)) continue;
      fixtures.push({
        slug: `${protocolClass}/${entry.name}`,
        fixturePath: path.relative(repoRoot, path.join(classDir, entry.name))
      });
    }
  }
  return fixtures.sort((a, b) => a.slug.localeCompare(b.slug));
}

function catalogShapeDiagnostics(catalog: ScenarioCatalog): CatalogDiagnostic[] {
  const diagnostics: CatalogDiagnostic[] = [];
  const slugs = new Set<string>();
  const familySlugs = new Set<string>();

  for (const family of catalog.family) {
    if (slugs.has(family.slug)) {
      diagnostics.push({
        code: "duplicate_slug",
        slug: family.slug,
        message: `duplicate catalog slug: ${family.slug}`
      });
    }
    slugs.add(family.slug);

    const [slugClass, familySlug] = family.slug.split("/") as [
      ProtocolClass,
      string
    ];
    if (slugClass !== family.class) {
      diagnostics.push({
        code: "slug_class_mismatch",
        slug: family.slug,
        message: `${family.slug} class field is ${family.class}, expected ${slugClass}`
      });
    }

    if (familySlugs.has(familySlug)) {
      diagnostics.push({
        code: "duplicate_family_slug",
        slug: family.slug,
        message: `family slug ${familySlug} is reused; family slugs must be unique across classes`
      });
    }
    familySlugs.add(familySlug);

    const expectedPath = `fixtures/scenarios/${family.class}/${familySlug}`;
    if (family.fixture_path !== expectedPath) {
      diagnostics.push({
        code: "fixture_path_mismatch",
        slug: family.slug,
        path: family.fixture_path,
        message: `${family.slug} fixture_path is ${family.fixture_path}; expected ${expectedPath}`
      });
    }
  }

  return diagnostics;
}

function discoverPresentationArtifacts(repoRoot: string): PresentationArtifact[] {
  const heroGridPath = "fixtures/analysis/lending/hero-grid/";
  if (!existsSync(path.join(repoRoot, heroGridPath))) {
    return [];
  }
  return [
    {
      path: heroGridPath,
      derivedFrom: "lending/whale-shock-grid"
    }
  ];
}

async function sha256File(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const CLASS_LABELS: Record<ProtocolClass, string> = {
  lending: "Lending",
  stablecoin: "Stablecoin",
  "liquid-staking": "Liquid Staking",
  perpetuals: "Perpetuals",
  amm: "AMM"
};
