import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadAdapter, type AdapterLoadError } from "../adapter/resolve.js";
import { cliPackageRootFromModule, monorepoRootFromModule } from "../orchestrator/index.js";
import { resolveAdapterRuntime, type Adapter } from "../schemas/adapter.js";
import { loadGenericIdl } from "./idl.js";
import { renderAccounts } from "./render-accounts.js";
import { renderBootstrapManifest } from "./render-manifest.js";
import {
  renderFlows,
  renderInvariants,
  renderMain,
  renderOracleService,
  renderServicesMod,
  simCrateName
} from "./render-main.js";
import { renderTypes } from "./render-types.js";

export interface SimGenerateOptions {
  adapter?: string;
  dir?: string;
  forceGenerated?: boolean;
  regenTypesOnly?: boolean;
}

export interface SimGenerateResult {
  dir: string;
  manifestPath: string;
  bootstrapManifestPath: string;
  adapterPath: string;
  idlPath: string;
}

export async function generateSim(
  cwd: string,
  options: SimGenerateOptions
): Promise<SimGenerateResult> {
  const resolved = await resolveAdapterForSim(cwd, options.adapter);
  const runtime = resolveAdapterRuntime(resolved.adapter);
  if (runtime !== "generic") {
    throw new Error(
      `guided simulations currently require an IDL-backed generic adapter; ${resolved.path} resolves to ${runtime}`
    );
  }
  if (!resolved.adapter.idl_path) {
    throw new Error(`${resolved.path} does not declare idl_path`);
  }

  const adapterDir = path.dirname(resolved.path);
  const idlPath = path.resolve(adapterDir, resolved.adapter.idl_path);
  const idl = await loadGenericIdl(idlPath);
  const outDir = path.resolve(cwd, options.dir ?? ".riptide/sim");
  const srcDir = path.join(outDir, "src");
  const servicesDir = path.join(srcDir, "services");
  const manifestPath = path.join(outDir, "Cargo.toml");
  const bootstrapManifestPath = path.join(outDir, "Riptide.toml");
  const forceUserOwned = options.forceGenerated === true;
  const programSoPath = resolved.adapter.program_so
    ? path.resolve(adapterDir, resolved.adapter.program_so)
    : undefined;

  await mkdir(servicesDir, { recursive: true });
  await writeFile(path.join(srcDir, "types.rs"), renderTypes(idl), "utf8");
  await writeFile(path.join(srcDir, "accounts.rs"), renderAccounts(resolved.adapter), "utf8");

  if (!options.regenTypesOnly) {
    await writeFile(manifestPath, renderCargoToml(simCrateName(resolved.path)), "utf8");
    await writeFile(
      path.join(srcDir, "main.rs"),
      renderMain(resolved.adapter, {
        adapterPath: resolved.path,
        idlProgramId: idl.address,
        programSoPath
      }),
      "utf8"
    );
    await writeIfFirst(path.join(srcDir, "flows.rs"), renderFlows(), forceUserOwned);
    await writeIfFirst(path.join(srcDir, "invariants.rs"), renderInvariants(), forceUserOwned);
    await writeIfFirst(path.join(servicesDir, "mod.rs"), renderServicesMod(), forceUserOwned);
    await writeIfFirst(path.join(servicesDir, "oracle.rs"), renderOracleService(), forceUserOwned);
    await writeIfFirst(bootstrapManifestPath, renderBootstrapManifest(), forceUserOwned);
    await copyRuntimeLockfileIfPresent(outDir);
  }

  return { dir: outDir, manifestPath, bootstrapManifestPath, adapterPath: resolved.path, idlPath };
}

async function writeIfFirst(filePath: string, content: string, force: boolean): Promise<void> {
  if (!force && existsSync(filePath)) return;
  await writeFile(filePath, content, "utf8");
}

function renderCargoToml(crateName: string): string {
  const simDep = simDependency("riptide-sim");
  const macrosDep = simDependency("riptide-sim-macros");
  return `[package]
name = "${sanitizeCrateName(crateName)}"
version = "0.1.0"
edition = "2021"
publish = false

[workspace]

[dependencies]
anyhow = "1.0"
borsh = { version = "1.6.1", features = ["derive"] }
riptide-sim = ${simDep}
riptide-sim-macros = ${macrosDep}
`;
}

function simDependency(crateDir: "riptide-sim" | "riptide-sim-macros"): string {
  const dir = runtimeCratePath(crateDir);
  if (!dir) {
    throw new Error(
      `guided simulation runtime crate ${crateDir} was not found in the source checkout or packaged CLI runtime`
    );
  }
  return `{ path = ${JSON.stringify(dir)} }`;
}

function runtimeCratePath(crateDir: "riptide-sim" | "riptide-sim-macros"): string | undefined {
  const root = monorepoRootFromModule();
  if (root && existsSync(path.join(root, "Cargo.toml"))) {
    const sourceDir = path.join(root, crateDir);
    if (existsSync(path.join(sourceDir, "Cargo.toml"))) return sourceDir;
  }

  const packageRoot = cliPackageRootFromModule();
  if (packageRoot) {
    const bundledDir = path.join(packageRoot, "dist", "sim-runtime", crateDir);
    if (existsSync(path.join(bundledDir, "Cargo.toml"))) return bundledDir;
  }

  return undefined;
}

async function copyRuntimeLockfileIfPresent(outDir: string): Promise<void> {
  const lockPath = runtimeLockfilePath();
  if (!lockPath) return;
  await copyFile(lockPath, path.join(outDir, "Cargo.lock"));
}

function runtimeLockfilePath(): string | undefined {
  const root = monorepoRootFromModule();
  if (root && existsSync(path.join(root, "Cargo.toml"))) {
    const lockPath = path.join(root, "Cargo.lock");
    if (existsSync(lockPath)) return lockPath;
  }

  const packageRoot = cliPackageRootFromModule();
  if (packageRoot) {
    const lockPath = path.join(packageRoot, "dist", "sim-runtime", "Cargo.lock");
    if (existsSync(lockPath)) return lockPath;
  }

  return undefined;
}

async function resolveAdapterForSim(
  cwd: string,
  adapterArg: string | undefined
): Promise<{ path: string; adapter: Adapter }> {
  if (!adapterArg || adapterArg.length === 0) {
    throw new Error("pass --adapter <path-or-name> to generate a guided simulation");
  }
  const loaded = await loadAdapter(adapterArg, { cwd });
  if (!loaded.ok) {
    throw new Error(renderAdapterLoadError(loaded.error));
  }
  return { path: loaded.value.resolved.path, adapter: loaded.value.adapter };
}

function sanitizeCrateName(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/_/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function renderAdapterLoadError(error: AdapterLoadError): string {
  switch (error.kind) {
    case "not-found":
      return `adapter ${error.arg} was not found`;
    case "read-failed":
      return `failed to read adapter ${error.path}: ${error.message}`;
    case "validation-failed":
      return `adapter ${error.path} is invalid: ${error.message}`;
  }
}
