// Best-effort program-name detection for the Studio first-run wizard.
//
// Order:
//   1. Anchor.toml — reuses cli/src/init/index.ts::inferProgramName.
//   2. Cargo workspace — `programs/*/Cargo.toml` (Anchor convention).
//   3. Top-level `Cargo.toml` `[package].name` if `[lib].crate-type`
//      includes "cdylib" (the Solana program convention).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { inferProgramName } from "../init/index.js";

export type DetectSource = "anchor" | "cargo-workspace" | "cargo-package";

export interface DetectedCandidate {
  programName: string;
  source: DetectSource;
  manifestPath: string;
}

export interface ProgramDetection {
  programName: string | null;
  source: DetectSource | null;
  manifestPath: string | null;
  candidates: DetectedCandidate[];
}

const NAME_RE = /^\s*name\s*=\s*"([a-z][a-z0-9_-]*)"\s*$/m;
const CRATE_TYPE_RE = /crate-type\s*=\s*\[([^\]]*)\]/;

export function detectProgramForStudio(cwd: string): ProgramDetection {
  const candidates: DetectedCandidate[] = [];
  const anchorName = safeInferAnchor(cwd);
  if (anchorName) {
    candidates.push({ programName: anchorName, source: "anchor", manifestPath: path.join(cwd, "Anchor.toml") });
  }
  for (const c of scanProgramsDir(cwd)) {
    if (!candidates.some((existing) => existing.programName === c.programName)) candidates.push(c);
  }
  const topLevelCdylib = readTopLevelCdylib(cwd);
  if (topLevelCdylib && !candidates.some((c) => c.programName === topLevelCdylib.programName)) {
    candidates.push(topLevelCdylib);
  }
  const primary = candidates[0] ?? null;
  return {
    programName: primary?.programName ?? null,
    source: primary?.source ?? null,
    manifestPath: primary?.manifestPath ?? null,
    candidates
  };
}

function safeInferAnchor(cwd: string): string | null {
  try { return inferProgramName(cwd); } catch { return null; }
}

function scanProgramsDir(cwd: string): DetectedCandidate[] {
  const programsDir = path.join(cwd, "programs");
  if (!safeIsDirectory(programsDir)) return [];
  const out: DetectedCandidate[] = [];
  let entries: string[];
  try { entries = readdirSync(programsDir); } catch { return []; }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const candidateDir = path.join(programsDir, entry);
    if (!safeIsDirectory(candidateDir)) continue;
    const cargoPath = path.join(candidateDir, "Cargo.toml");
    if (!existsSync(cargoPath)) continue;
    const name = readPackageNameIfCdylib(cargoPath) ?? readPackageName(cargoPath);
    if (!name) continue;
    out.push({ programName: normalizeProgramName(name), source: "cargo-workspace", manifestPath: cargoPath });
  }
  return out;
}

function readTopLevelCdylib(cwd: string): DetectedCandidate | null {
  const cargoPath = path.join(cwd, "Cargo.toml");
  if (!existsSync(cargoPath)) return null;
  const name = readPackageNameIfCdylib(cargoPath);
  if (!name) return null;
  return { programName: normalizeProgramName(name), source: "cargo-package", manifestPath: cargoPath };
}

function readPackageNameIfCdylib(cargoPath: string): string | null {
  let raw: string;
  try { raw = readFileSync(cargoPath, "utf8"); } catch { return null; }
  const ct = raw.match(CRATE_TYPE_RE);
  if (!ct || !ct[1]?.includes("cdylib")) return null;
  return readPackageNameFromRaw(raw);
}

function readPackageName(cargoPath: string): string | null {
  let raw: string;
  try { raw = readFileSync(cargoPath, "utf8"); } catch { return null; }
  return readPackageNameFromRaw(raw);
}

function readPackageNameFromRaw(raw: string): string | null {
  const sectionMatch = raw.match(/\[package\][^[]*/);
  if (!sectionMatch) return null;
  const m = sectionMatch[0].match(NAME_RE);
  return m ? (m[1] ?? null) : null;
}

function normalizeProgramName(raw: string): string {
  return raw.toLowerCase().replace(/_/g, "-").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

function safeIsDirectory(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
