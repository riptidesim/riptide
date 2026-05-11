import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

export type StudioWorkspaceChangeStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted"
  | "typechange"
  | "unknown";

export interface StudioWorkspaceChange {
  path: string;
  old_path: string | null;
  status: StudioWorkspaceChangeStatus;
  index_status: string;
  worktree_status: string;
  staged: boolean;
  unstaged: boolean;
}

export interface WorkspaceStatusEntry extends StudioWorkspaceChange {
  fingerprint: string;
  source: "git" | "filesystem";
}

export interface WorkspaceStatusSnapshot {
  capturedAt: string;
  isGitWorkspace: boolean;
  warnings: string[];
  entries: WorkspaceStatusEntry[];
}

export interface StudioChangesPayload {
  schema_version: "studio-changes.v1";
  workspace_id: string;
  workspace_path: string;
  scope: "workspace" | "chat_thread";
  thread_id: string | null;
  is_git_workspace: boolean;
  generated_at: string;
  changes: StudioWorkspaceChange[];
  warnings: string[];
}

export interface ThreadWorkspaceChangesState {
  schemaVersion: "studio-chat-thread-changes.v1";
  threadId: string;
  baselineCapturedAt: string;
  baseline: WorkspaceStatusEntry[];
  updatedAt: string;
  isGitWorkspace: boolean;
  warnings: string[];
  changes: StudioWorkspaceChange[];
}

const MAX_WATCHED_FILES = 5000;

export async function readCurrentWorkspaceChanges(
  workspaceId: string,
  workspacePath: string
): Promise<StudioChangesPayload> {
  const snapshot = await readWorkspaceStatusSnapshot(workspacePath);
  return buildStudioChangesPayload({
    workspaceId,
    workspacePath,
    scope: "workspace",
    threadId: null,
    isGitWorkspace: snapshot.isGitWorkspace,
    changes: stripFingerprints(snapshot.entries),
    warnings: snapshot.warnings,
    generatedAt: snapshot.capturedAt
  });
}

export async function readWorkspaceStatusSnapshot(workspacePath: string): Promise<WorkspaceStatusSnapshot> {
  const root = path.resolve(workspacePath);
  const capturedAt = new Date().toISOString();
  try {
    const { stdout } = await execFilePromise(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: root, maxBuffer: 1024 * 1024, timeoutMs: 5000 }
    );
    const parsed = parseGitPorcelainZ(stdout).filter((change) => !isIgnoredChangePath(change.path));
    const gitEntries = await Promise.all(parsed.map((change) => withFingerprint(root, change, "git")));
    const watched = await readWatchedFilesystemEntries(root);
    const byPath = new Map<string, WorkspaceStatusEntry>();
    for (const entry of gitEntries) byPath.set(changeKey(entry), entry);
    for (const entry of watched.entries) {
      if (!byPath.has(changeKey(entry))) byPath.set(changeKey(entry), entry);
    }
    const entries = Array.from(byPath.values());
    entries.sort((a, b) => a.path.localeCompare(b.path));
    return {
      capturedAt,
      isGitWorkspace: true,
      warnings: watched.warnings,
      entries
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; code?: unknown };
    const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
    const missingGit = e.code === "ENOENT";
    const notRepo = /not a git repository/i.test(stderr);
    return {
      capturedAt,
      isGitWorkspace: false,
      entries: [],
      warnings: [
        missingGit
          ? "git is not available on PATH"
          : notRepo
            ? "workspace is not inside a git repository"
            : stderr || (e.message || "could not read git status")
      ]
    };
  }
}

export function diffWorkspaceSnapshots(
  baseline: WorkspaceStatusSnapshot,
  current: WorkspaceStatusSnapshot
): StudioWorkspaceChange[] {
  if (!baseline.isGitWorkspace || !current.isGitWorkspace) return [];
  const before = new Map<string, WorkspaceStatusEntry>();
  for (const entry of baseline.entries) {
    before.set(changeKey(entry), entry);
  }
  const afterKeys = new Set<string>();
  const changed: StudioWorkspaceChange[] = [];
  for (const entry of current.entries) {
    const key = changeKey(entry);
    afterKeys.add(key);
    const previous = before.get(key);
    if (!previous) {
      changed.push(stripSnapshotFields(entry, entry.source === "filesystem" ? "added" : entry.status));
    } else if (changeSignature(previous) !== changeSignature(entry)) {
      changed.push(stripSnapshotFields(entry, entry.source === "filesystem" ? "modified" : entry.status));
    }
  }
  for (const entry of baseline.entries) {
    if (!afterKeys.has(changeKey(entry))) {
      changed.push(stripSnapshotFields(entry, entry.source === "filesystem" ? "deleted" : "modified"));
    }
  }
  changed.sort((a, b) => a.path.localeCompare(b.path));
  return changed;
}

export function buildStudioChangesPayload(input: {
  workspaceId: string;
  workspacePath: string;
  scope: "workspace" | "chat_thread";
  threadId: string | null;
  isGitWorkspace: boolean;
  changes: StudioWorkspaceChange[];
  warnings: string[];
  generatedAt?: string;
}): StudioChangesPayload {
  return {
    schema_version: "studio-changes.v1",
    workspace_id: input.workspaceId,
    workspace_path: path.resolve(input.workspacePath),
    scope: input.scope,
    thread_id: input.threadId,
    is_git_workspace: input.isGitWorkspace,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    changes: input.changes,
    warnings: input.warnings
  };
}

export function snapshotFromThreadChangesState(state: ThreadWorkspaceChangesState): WorkspaceStatusSnapshot {
  return {
    capturedAt: state.baselineCapturedAt,
    isGitWorkspace: state.isGitWorkspace,
    warnings: state.warnings,
    entries: state.baseline
  };
}

export function createThreadChangesState(input: {
  threadId: string;
  baseline: WorkspaceStatusSnapshot;
  current?: WorkspaceStatusSnapshot;
  changes?: StudioWorkspaceChange[];
}): ThreadWorkspaceChangesState {
  const current = input.current ?? input.baseline;
  return {
    schemaVersion: "studio-chat-thread-changes.v1",
    threadId: input.threadId,
    baselineCapturedAt: input.baseline.capturedAt,
    baseline: input.baseline.entries,
    updatedAt: current.capturedAt,
    isGitWorkspace: current.isGitWorkspace,
    warnings: current.warnings,
    changes: input.changes ?? []
  };
}

function execFilePromise(
  file: string,
  args: string[],
  options: { cwd?: string; maxBuffer?: number; timeoutMs?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: "utf8",
        cwd: options.cwd,
        maxBuffer: options.maxBuffer ?? 64 * 1024,
        timeout: options.timeoutMs ?? 10 * 60 * 1000,
        windowsHide: false
      },
      (err, stdout, stderr) => {
        if (err) {
          Object.assign(err, { stdout, stderr });
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

function parseGitPorcelainZ(raw: string): StudioWorkspaceChange[] {
  const tokens = raw.split("\0").filter((token) => token.length > 0);
  const changes: StudioWorkspaceChange[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.length < 4) continue;
    const indexStatus = token[0] ?? " ";
    const worktreeStatus = token[1] ?? " ";
    const filePath = token.slice(3);
    let oldPath: string | null = null;
    if (indexStatus === "R" || worktreeStatus === "R" || indexStatus === "C" || worktreeStatus === "C") {
      oldPath = tokens[i + 1] ?? null;
      i += 1;
    }
    changes.push({
      path: filePath,
      old_path: oldPath,
      status: classifyGitStatus(indexStatus, worktreeStatus),
      index_status: indexStatus,
      worktree_status: worktreeStatus,
      staged: indexStatus !== " " && indexStatus !== "?" && indexStatus !== "!",
      unstaged: (worktreeStatus !== " " && worktreeStatus !== "!") || indexStatus === "?"
    });
  }
  return changes;
}

function classifyGitStatus(indexStatus: string, worktreeStatus: string): StudioWorkspaceChangeStatus {
  const pair = `${indexStatus}${worktreeStatus}`;
  if (pair === "??") return "untracked";
  if (indexStatus === "U" || worktreeStatus === "U" || pair === "AA" || pair === "DD") return "conflicted";
  if (indexStatus === "R" || worktreeStatus === "R") return "renamed";
  if (indexStatus === "C" || worktreeStatus === "C") return "copied";
  if (indexStatus === "D" || worktreeStatus === "D") return "deleted";
  if (indexStatus === "A" || worktreeStatus === "A") return "added";
  if (indexStatus === "T" || worktreeStatus === "T") return "typechange";
  if (indexStatus === "M" || worktreeStatus === "M") return "modified";
  return "unknown";
}

async function readWatchedFilesystemEntries(root: string): Promise<{ entries: WorkspaceStatusEntry[]; warnings: string[] }> {
  const start = path.join(root, ".riptide");
  try {
    const s = await lstat(start);
    if (!s.isDirectory()) return { entries: [], warnings: [] };
  } catch {
    return { entries: [], warnings: [] };
  }

  const entries: WorkspaceStatusEntry[] = [];
  const warnings: string[] = [];
  const stack = [".riptide"];
  while (stack.length > 0) {
    const relDir = stack.pop()!;
    let dirents: Dirent[];
    try {
      dirents = await readdir(path.join(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      const rel = toPosixPath(path.join(relDir, dirent.name));
      if (isIgnoredChangePath(rel) || isHeavyRiptidePath(rel)) continue;
      if (dirent.isDirectory()) {
        stack.push(rel);
        continue;
      }
      if (!dirent.isFile() && !dirent.isSymbolicLink()) continue;
      if (entries.length >= MAX_WATCHED_FILES) {
        warnings.push(`workspace change scan stopped after ${MAX_WATCHED_FILES} .riptide files`);
        return { entries, warnings };
      }
      entries.push(await withFingerprint(root, {
        path: rel,
        old_path: null,
        status: "unknown",
        index_status: " ",
        worktree_status: " ",
        staged: false,
        unstaged: false
      }, "filesystem"));
    }
  }

  return { entries, warnings };
}

async function withFingerprint(
  root: string,
  change: StudioWorkspaceChange,
  source: WorkspaceStatusEntry["source"]
): Promise<WorkspaceStatusEntry> {
  const normalizedRoot = path.resolve(root);
  const absolute = path.resolve(normalizedRoot, change.path);
  const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
  if (absolute !== normalizedRoot && !absolute.startsWith(rootWithSep)) {
    return { ...change, source, fingerprint: "outside-workspace" };
  }
  try {
    const s = await lstat(absolute);
    const kind =
      s.isFile() ? "file" :
      s.isDirectory() ? "dir" :
      s.isSymbolicLink() ? "symlink" : "other";
    return { ...change, source, fingerprint: `${kind}:${s.size}:${s.mtimeMs}` };
  } catch {
    return { ...change, source, fingerprint: "missing" };
  }
}

function isIgnoredChangePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return (
    normalized === ".riptide/studio" ||
    normalized.startsWith(".riptide/studio/") ||
    normalized === ".riptide.bak" ||
    normalized.startsWith(".riptide.bak.")
  );
}

function isHeavyRiptidePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return (
    normalized === ".riptide/harness/target" ||
    normalized.startsWith(".riptide/harness/target/") ||
    normalized === ".riptide/sim/target" ||
    normalized.startsWith(".riptide/sim/target/") ||
    normalized === ".riptide/target" ||
    normalized.startsWith(".riptide/target/")
  );
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function stripFingerprints(entries: WorkspaceStatusEntry[]): StudioWorkspaceChange[] {
  return entries.map((entry) => stripSnapshotFields(entry, entry.status));
}

function stripSnapshotFields(entry: WorkspaceStatusEntry, status: StudioWorkspaceChangeStatus): StudioWorkspaceChange {
  const { fingerprint: _fingerprint, source: _source, ...change } = entry;
  const filesystemDerived = entry.source === "filesystem";
  return {
    ...change,
    status,
    index_status: filesystemDerived && status === "added" ? "?" : filesystemDerived ? " " : change.index_status,
    worktree_status:
      filesystemDerived && status === "added" ? "?" :
      filesystemDerived && status === "deleted" ? "D" :
      filesystemDerived && status === "modified" ? "M" :
      change.worktree_status,
    staged: status === "added" ? false : change.staged,
    unstaged: filesystemDerived && (status === "added" || status === "deleted" || status === "modified") ? true : change.unstaged
  };
}

function changeKey(change: StudioWorkspaceChange): string {
  return `${change.path}\0${change.old_path ?? ""}`;
}

function changeSignature(entry: WorkspaceStatusEntry): string {
  return [
    entry.index_status,
    entry.worktree_status,
    entry.status,
    entry.fingerprint
  ].join("\0");
}
