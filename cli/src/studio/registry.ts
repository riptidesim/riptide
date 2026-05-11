// User-level registry of Riptide projects.
//
// Lives at `~/.riptide/projects.json`. The Studio frontend reads this so
// the workspace rail shows every project the user has bootstrapped from
// the wizard, regardless of which directory `riptide studio` is run
// from.
//
// The file is plain JSON; we write atomically (write to temp, rename)
// to avoid leaving partial state on crash. Entries store an absolute
// path, a label, and a creation timestamp. Discovery validates that
// each registered path still has a `.riptide/` folder; the data layer
// returns flags so the caller decides whether to surface the missing
// entry or hide it.
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface RegisteredProject {
  /** Stable id used in API queries (random short hex). */
  id: string;
  /** Display label. */
  label: string;
  /** Absolute repo path. */
  path: string;
  /** ISO 8601 creation timestamp. */
  created_at: string;
  /** ISO 8601 last-opened timestamp; updated on each studio launch. */
  last_opened_at: string | null;
}

interface RegistryFile {
  schema_version: "riptide-projects.v1";
  projects: RegisteredProject[];
}

const SCHEMA_VERSION = "riptide-projects.v1" as const;

export interface RegistryPaths {
  /** Override the default `~/.riptide/`. Tests use this. */
  home?: string;
}

function registryDir(paths: RegistryPaths = {}): string {
  // Tests inject a tmp dir via the env var so the user-level registry
  // at ~/.riptide/projects.json doesn't leak into test runs.
  const home = paths.home ?? process.env.RIPTIDE_REGISTRY_HOME ?? homedir();
  return path.join(home, ".riptide");
}

function registryFile(paths: RegistryPaths = {}): string {
  return path.join(registryDir(paths), "projects.json");
}

async function readRegistry(paths: RegistryPaths = {}): Promise<RegistryFile> {
  const file = registryFile(paths);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return { schema_version: SCHEMA_VERSION, projects: [] };
    }
    throw err;
  }
  if (raw.trim().length === 0) {
    return { schema_version: SCHEMA_VERSION, projects: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { schema_version: SCHEMA_VERSION, projects: [] };
  }
  if (!parsed || typeof parsed !== "object") {
    return { schema_version: SCHEMA_VERSION, projects: [] };
  }
  const obj = parsed as Record<string, unknown>;
  const list = Array.isArray(obj.projects) ? obj.projects : [];
  const projects: RegisteredProject[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id : null;
    const label = typeof e.label === "string" ? e.label : null;
    const projectPath = typeof e.path === "string" ? e.path : null;
    if (!id || !label || !projectPath) continue;
    const createdAt = typeof e.created_at === "string" ? e.created_at : new Date().toISOString();
    const lastOpenedAt = typeof e.last_opened_at === "string" ? e.last_opened_at : null;
    projects.push({
      id,
      label,
      path: projectPath,
      created_at: createdAt,
      last_opened_at: lastOpenedAt
    });
  }
  return { schema_version: SCHEMA_VERSION, projects };
}

async function writeRegistry(file: RegistryFile, paths: RegistryPaths = {}): Promise<void> {
  const dir = registryDir(paths);
  await mkdir(dir, { recursive: true });
  const target = registryFile(paths);
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  const body = JSON.stringify({ schema_version: SCHEMA_VERSION, projects: file.projects }, null, 2) + "\n";
  await writeFile(tmp, body, "utf8");
  await rename(tmp, target);
}

export async function listProjects(paths: RegistryPaths = {}): Promise<RegisteredProject[]> {
  const file = await readRegistry(paths);
  return file.projects;
}

function newProjectId(): string {
  // Short random hex; doesn't need cryptographic quality, just uniqueness
  // among a user's local project list.
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return `prj_${out}`;
}

export interface RegisterProjectInput {
  label: string;
  path: string;
}

/**
 * Register a project. If an entry with the same absolute path already
 * exists, its label is updated and the existing id is reused. Otherwise
 * a new id is minted.
 */
export async function registerProject(
  input: RegisterProjectInput,
  paths: RegistryPaths = {}
): Promise<RegisteredProject> {
  const file = await readRegistry(paths);
  const absolute = path.resolve(input.path);
  const existing = file.projects.find((p) => p.path === absolute);
  if (existing) {
    existing.label = input.label;
    existing.last_opened_at = new Date().toISOString();
    await writeRegistry(file, paths);
    return existing;
  }
  const project: RegisteredProject = {
    id: newProjectId(),
    label: input.label,
    path: absolute,
    created_at: new Date().toISOString(),
    last_opened_at: null
  };
  file.projects.push(project);
  await writeRegistry(file, paths);
  return project;
}

export async function rememberProject(
  input: RegisterProjectInput,
  paths: RegistryPaths = {}
): Promise<RegisteredProject> {
  const file = await readRegistry(paths);
  const absolute = path.resolve(input.path);
  const now = new Date().toISOString();
  const existing = file.projects.find((p) => p.path === absolute);
  if (existing) {
    existing.last_opened_at = now;
    await writeRegistry(file, paths);
    return existing;
  }
  const project: RegisteredProject = {
    id: newProjectId(),
    label: input.label,
    path: absolute,
    created_at: now,
    last_opened_at: now
  };
  file.projects.push(project);
  await writeRegistry(file, paths);
  return project;
}

export async function removeProject(id: string, paths: RegistryPaths = {}): Promise<RegisteredProject | null> {
  const file = await readRegistry(paths);
  const removed = file.projects.find((p) => p.id === id) ?? null;
  if (!removed) return null;
  file.projects = file.projects.filter((p) => p.id !== id);
  await writeRegistry(file, paths);
  return removed;
}

export async function touchProject(absolutePath: string, paths: RegistryPaths = {}): Promise<void> {
  const file = await readRegistry(paths);
  const entry = file.projects.find((p) => p.path === absolutePath);
  if (!entry) return;
  entry.last_opened_at = new Date().toISOString();
  await writeRegistry(file, paths);
}

export async function projectHasRiptideDir(projectPath: string): Promise<boolean> {
  try {
    const s = await stat(path.join(projectPath, ".riptide"));
    return s.isDirectory();
  } catch {
    return false;
  }
}
