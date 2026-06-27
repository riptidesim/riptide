import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { loadAdapter, type AdapterLoadError } from "../adapter/resolve.js";
import { cliPackageRootFromModule, monorepoRootFromModule } from "../orchestrator/index.js";
import { resolveAdapterRuntime, resolveRuntimePath, type Adapter } from "../schemas/adapter.js";
import { loadGenericIdl } from "./idl.js";
import { renderAccounts } from "./render-accounts.js";
import { renderBootstrapManifest } from "./render-manifest.js";
import { renderInvariants } from "./render-invariants.js";
import { renderFlows } from "./render-flows.js";
import {
  renderMain,
  renderOracleService,
  renderServicesMod,
  renderTypesExt,
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

  const idlPath = resolveRuntimePath(resolved.adapter.idl_path, resolved.path);
  const idl = await loadGenericIdl(idlPath);
  const outDir = path.resolve(cwd, options.dir ?? ".riptide/sim");
  const srcDir = path.join(outDir, "src");
  const servicesDir = path.join(srcDir, "services");
  const manifestPath = path.join(outDir, "Cargo.toml");
  const bootstrapManifestPath = path.join(outDir, "Riptide.toml");
  const forceUserOwned = options.forceGenerated === true;
  const programSoPath = resolved.adapter.program_so
    ? resolveRuntimePath(resolved.adapter.program_so, resolved.path)
    : undefined;

  await mkdir(servicesDir, { recursive: true });
  await writeFile(path.join(srcDir, "types.rs"), renderTypes(idl), "utf8");
  await writeFile(path.join(srcDir, "accounts.rs"), renderAccounts(resolved.adapter), "utf8");

  if (!options.regenTypesOnly) {
    const runtimeSource = resolveRuntimeSource();
    if (!runtimeSource) {
      throw new Error(
        "guided simulation runtime crates were not found in the source checkout or packaged CLI runtime"
      );
    }
    const runtimePaths = await materializeRuntime(outDir, runtimeSource);
    await writeFile(
      manifestPath,
      renderCargoToml(simCrateName(resolved.path), runtimePaths),
      "utf8"
    );
    await writeFile(
      path.join(srcDir, "main.rs"),
      renderMain(resolved.adapter, {
        adapterPath: resolved.path,
        idlProgramId: idl.address,
        programSoPath
      }),
      "utf8"
    );
    await writeIfFirst(path.join(srcDir, "flows.rs"), renderFlows(resolved.adapter, idl), forceUserOwned);
    await writeIfFirst(
      path.join(srcDir, "invariants.rs"),
      renderInvariants(resolved.adapter, idl),
      forceUserOwned
    );
    // Pin the sim crate's toolchain so a case-study root that pins an older
    // channel (for its own program build) doesn't break the sim's edition2024
    // dependency tree via cargo's upward rust-toolchain.toml resolution.
    await writeIfFirst(path.join(outDir, "rust-toolchain.toml"), renderRustToolchain(), forceUserOwned);
    await writeIfFirst(path.join(srcDir, "types_ext.rs"), renderTypesExt(), forceUserOwned);
    await writeIfFirst(path.join(servicesDir, "mod.rs"), renderServicesMod(), forceUserOwned);
    await writeIfFirst(path.join(servicesDir, "oracle.rs"), renderOracleService(), forceUserOwned);
    await writeIfFirst(bootstrapManifestPath, renderBootstrapManifest(), forceUserOwned);
    await copyRuntimeLockfile(outDir, runtimeSource);
  }

  return { dir: outDir, manifestPath, bootstrapManifestPath, adapterPath: resolved.path, idlPath };
}

async function writeIfFirst(filePath: string, content: string, force: boolean): Promise<void> {
  if (!force && existsSync(filePath)) return;
  await writeFile(filePath, content, "utf8");
}

export function renderRustToolchain(): string {
  return `[toolchain]
channel = "1.89.0"
`;
}

export function renderCargoToml(crateName: string, runtime: RuntimeCratePaths): string {
  return `[package]
name = "${sanitizeCrateName(crateName)}"
version = "0.1.0"
edition = "2021"
publish = false

[workspace]

[dependencies]
anyhow = "1.0"
borsh = { version = "1.6.1", features = ["derive"] }
riptide-sim = { path = ${JSON.stringify(runtime.simPath)} }
riptide-sim-macros = { path = ${JSON.stringify(runtime.macrosPath)} }
`;
}

export interface SimRuntimeSource {
  kind: "workspace" | "packaged";
  simDir: string;
  macrosDir: string;
  lockfilePath?: string;
}

export interface RuntimeCratePaths {
  simPath: string;
  macrosPath: string;
}

// Where the generated crate's riptide-sim / riptide-sim-macros dependencies
// come from. A source checkout (or an npm-linked CLI, which realpath-resolves
// back into it) wins and keeps live path deps so runtime edits are picked up
// without re-vendoring; otherwise the packaged CLI's bundled runtime under
// dist/sim-runtime is the source and gets copied next to the generated crate.
function resolveRuntimeSource(): SimRuntimeSource | undefined {
  return runtimeSourceFromRoots(monorepoRootFromModule(), cliPackageRootFromModule());
}

export function runtimeSourceFromRoots(
  workspaceRoot: string | undefined,
  packageRoot: string | undefined
): SimRuntimeSource | undefined {
  if (workspaceRoot && existsSync(path.join(workspaceRoot, "Cargo.toml"))) {
    const simDir = path.join(workspaceRoot, "riptide-sim");
    const macrosDir = path.join(workspaceRoot, "riptide-sim-macros");
    if (existsSync(path.join(simDir, "Cargo.toml")) && existsSync(path.join(macrosDir, "Cargo.toml"))) {
      const lockfilePath = path.join(workspaceRoot, "Cargo.lock");
      return {
        kind: "workspace",
        simDir,
        macrosDir,
        lockfilePath: existsSync(lockfilePath) ? lockfilePath : undefined
      };
    }
  }

  if (packageRoot) {
    const runtimeDir = path.join(packageRoot, "dist", "sim-runtime");
    const simDir = path.join(runtimeDir, "riptide-sim");
    const macrosDir = path.join(runtimeDir, "riptide-sim-macros");
    if (existsSync(path.join(simDir, "Cargo.toml")) && existsSync(path.join(macrosDir, "Cargo.toml"))) {
      const lockfilePath = path.join(runtimeDir, "Cargo.lock");
      return {
        kind: "packaged",
        simDir,
        macrosDir,
        lockfilePath: existsSync(lockfilePath) ? lockfilePath : undefined
      };
    }
  }

  return undefined;
}

// Packaged installs copy the runtime crates into <sim>/vendor/ so the crate
// is self-contained: it builds on any machine, can be committed and shared,
// and survives CLI upgrades that replace the npm package directory. The copy
// is refreshed on every full generate so it always matches the installed CLI.
export async function materializeRuntime(
  outDir: string,
  source: SimRuntimeSource
): Promise<RuntimeCratePaths> {
  if (source.kind === "workspace") {
    return { simPath: source.simDir, macrosPath: source.macrosDir };
  }
  const vendorDir = path.join(outDir, "vendor");
  await rm(vendorDir, { recursive: true, force: true });
  await mkdir(vendorDir, { recursive: true });
  await cp(source.simDir, path.join(vendorDir, "riptide-sim"), { recursive: true });
  await cp(source.macrosDir, path.join(vendorDir, "riptide-sim-macros"), { recursive: true });
  return { simPath: "vendor/riptide-sim", macrosPath: "vendor/riptide-sim-macros" };
}

async function copyRuntimeLockfile(outDir: string, source: SimRuntimeSource): Promise<void> {
  if (!source.lockfilePath) return;
  await copyFile(source.lockfilePath, path.join(outDir, "Cargo.lock"));
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
