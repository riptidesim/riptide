import { existsSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";

import { monorepoRootFromModule } from "../orchestrator/index.js";
import {
  PROTOCOL_CLASSES,
  loadScenarioCatalog,
  sortFamilies,
  type ProtocolClass,
  type ScenarioCatalog
} from "../scenarios/catalog.js";

const CLASS_LABELS: Record<ProtocolClass, string> = {
  lending: "Lending",
  stablecoin: "Stablecoin",
  "liquid-staking": "Liquid Staking",
  perpetuals: "Perpetuals",
  amm: "AMM"
};

export interface ScenariosCatalogCommandDeps {
  repoRoot?: string;
  catalogPath?: string;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

export function createScenariosCatalogCommand(
  deps: ScenariosCatalogCommandDeps = {}
): Command {
  return new Command("catalog")
    .description(
      "Print the public 25-family scenario catalog grouped by protocol class"
    )
    .action(async () => {
      const exit = await runScenariosCatalog(deps);
      process.exitCode = exit;
    });
}

export async function runScenariosCatalog(
  deps: ScenariosCatalogCommandDeps = {}
): Promise<number> {
  const repoRoot = path.resolve(deps.repoRoot ?? defaultRepoRoot());
  const catalogPath =
    deps.catalogPath ?? path.join(repoRoot, "fixtures/scenarios/catalog.toml");
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  let catalog: ScenarioCatalog;
  try {
    catalog = await loadScenarioCatalog(catalogPath);
  } catch (err) {
    stderr.write(`riptide scenarios catalog: ${errMessage(err)}\n`);
    return 1;
  }

  stdout.write(
    renderScenarioCatalogText(catalog, {
      sourcePath: path.relative(repoRoot, catalogPath) || catalogPath
    })
  );
  return 0;
}

export function renderScenarioCatalogText(
  catalog: ScenarioCatalog,
  options: { sourcePath?: string } = {}
): string {
  const families = sortFamilies(catalog.family);
  const lines: string[] = [];

  lines.push("Riptide Scenario Family Catalog");
  lines.push(`Source: ${options.sourcePath ?? "fixtures/scenarios/catalog.toml"}`);
  lines.push(`Total families: ${families.length}`);
  lines.push("");

  for (const protocolClass of PROTOCOL_CLASSES) {
    const rows = families.filter((family) => family.class === protocolClass);
    lines.push(`${protocolClass} (${CLASS_LABELS[protocolClass]}, ${rows.length} families)`);
    for (const family of rows) {
      const familySlug = family.slug.split("/")[1] ?? family.slug;
      lines.push(
        `  - ${familySlug} | claim_level=${family.claim_level} | ${family.name}`
      );
      lines.push(`    summary: ${family.summary}`);
      lines.push(`    fixture: ${family.fixture_path}`);
      if (family.notes) {
        lines.push(`    notes: ${family.notes}`);
      }
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function defaultRepoRoot(): string {
  const fromEnv = process.env.RIPTIDE_MONOREPO_ROOT;
  if (fromEnv && existsSync(path.join(fromEnv, "fixtures/scenarios/catalog.toml"))) {
    return fromEnv;
  }

  const fromModule = monorepoRootFromModule();
  if (fromModule && existsSync(path.join(fromModule, "fixtures/scenarios/catalog.toml"))) {
    return fromModule;
  }

  return process.cwd();
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
