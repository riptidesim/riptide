// Studio job queue.
//
// Studio's job model is intentionally narrow. The frontend submits a
// kind + structured params; the server maps them to an explicit argv
// and spawns the local Riptide CLI with no shell interpolation. Push
// or publish style commands are rejected before they ever reach a
// process boundary.
//
// Concurrency is bounded at one running job per process (the spec's
// safe scope cut). Multiple jobs queue cleanly. Each job persists to
// `.riptide/studio/jobs/<id>.json` so a browser refresh does not
// erase the work list.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { StudioWorkspace } from "./workspaces.js";

export type JobKind =
  | "run"
  | "replay"
  | "campaign-validate"
  | "campaign-plan"
  | "campaign-run"
  | "review"
  | "readiness";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface Job {
  id: string;
  kind: JobKind;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  workspace_id: string;
  cwd: string;
  argv: string[];
  output_path: string | null;
  expected_artifact: string | null;
  exit_code: number | null;
  stdout_tail: string;
  stderr_tail: string;
  artifact_paths: string[];
  warnings: string[];
}

export interface JobPlanPreview {
  kind: JobKind;
  argv: string[];
  cwd: string;
  output_path: string | null;
  expected_artifact: string | null;
  command_string: string;
  notes: string[];
}

export interface JobLaunchInput {
  workspaceId: string;
  kind: JobKind;
  params: Record<string, string>;
}

export interface JobValidationError {
  status: number;
  payload: Record<string, unknown>;
}

const VALID_KINDS = new Set<JobKind>([
  "run",
  "replay",
  "campaign-validate",
  "campaign-plan",
  "campaign-run",
  "review",
  "readiness"
]);

// Anything outside this allowlist is hard-rejected at the server.
// These are the only argv[0] -> sub-action shapes Studio is allowed to
// spawn. Push/publish/release/login/install style argv[0] values are
// rejected even if they appear under `riptide`.
const FORBIDDEN_TOKENS = new Set([
  "push",
  "publish",
  "release",
  "login",
  "install",
  "uninstall",
  "rm",
  "mv",
  "delete",
  "deploy"
]);

const TAIL_BYTES = 16_384;

interface JobInternal {
  job: Job;
  proc: ChildProcess | null;
  cancelRequested: boolean;
  /** Resolves when the job finishes (any terminal status). */
  done?: Promise<void>;
}

export interface JobQueueOptions {
  /** CLI binary path used for spawned commands. Defaults to the current node + dist/src/index.js layout. */
  cliBin?: { node: string; entry: string };
  /** Persistence root. Defaults to `<workspace>/.riptide/studio/jobs`. */
  persistRoot?: (workspace: StudioWorkspace) => string;
  /** Maximum concurrent running jobs. Defaults to 1. */
  concurrency?: number;
}

export class StudioJobQueue {
  private readonly jobs = new Map<string, JobInternal>();
  private readonly orderedIds: string[] = [];
  private readonly cliBin: { node: string; entry: string };
  private readonly persistRootFor: (workspace: StudioWorkspace) => string;
  private readonly concurrency: number;
  private active = 0;
  private workspaces = new Map<string, StudioWorkspace>();

  constructor(options: JobQueueOptions = {}) {
    this.cliBin = options.cliBin ?? defaultCliBin();
    this.persistRootFor =
      options.persistRoot ?? ((w) => path.join(w.path, ".riptide", "studio", "jobs"));
    this.concurrency = Math.max(1, options.concurrency ?? 1);
  }

  setWorkspaces(workspaces: StudioWorkspace[]): void {
    this.workspaces = new Map(workspaces.map((w) => [w.id, w]));
  }

  list(): Job[] {
    return this.orderedIds
      .map((id) => this.jobs.get(id)?.job)
      .filter((job): job is Job => Boolean(job));
  }

  get(id: string): Job | null {
    return this.jobs.get(id)?.job ?? null;
  }

  /** Validate input + map to argv without spawning. Throws JobValidationError. */
  plan(input: JobLaunchInput): JobPlanPreview | JobValidationError {
    if (!VALID_KINDS.has(input.kind)) {
      return validationError(400, "invalid_kind", `unknown job kind: ${input.kind}`);
    }
    const workspace = this.workspaces.get(input.workspaceId);
    if (!workspace) {
      return validationError(404, "workspace_not_found", `workspace ${input.workspaceId} is not registered`);
    }
    const built = buildArgvForKind(input.kind, input.params, workspace);
    if ("error" in built) return built.error;

    const argv = ["riptide", ...built.argv];
    const forbidden = argv.find((token) => FORBIDDEN_TOKENS.has(token.toLowerCase()));
    if (forbidden) {
      return validationError(
        400,
        "forbidden_command",
        `Studio cannot launch commands containing ${JSON.stringify(forbidden)}; push/publish/release/install paths are out of scope.`
      );
    }
    return {
      kind: input.kind,
      argv,
      cwd: workspace.path,
      output_path: built.outputPath,
      expected_artifact: built.expectedArtifact,
      command_string: argv.map(quoteArg).join(" "),
      notes: built.notes
    };
  }

  /** Plan + persist + spawn (when not at concurrency cap). */
  async launch(input: JobLaunchInput): Promise<Job | JobValidationError> {
    const planResult = this.plan(input);
    if (isValidationError(planResult)) {
      return planResult;
    }
    const plan = planResult;
    const workspace = this.workspaces.get(input.workspaceId)!;
    const now = new Date().toISOString();
    const job: Job = {
      id: randomUUID(),
      kind: input.kind,
      status: "queued",
      created_at: now,
      updated_at: now,
      workspace_id: input.workspaceId,
      cwd: plan.cwd,
      argv: plan.argv,
      output_path: plan.output_path,
      expected_artifact: plan.expected_artifact,
      exit_code: null,
      stdout_tail: "",
      stderr_tail: "",
      artifact_paths: [],
      warnings: plan.notes
    };
    const internal: JobInternal = { job, proc: null, cancelRequested: false };
    this.jobs.set(job.id, internal);
    this.orderedIds.push(job.id);
    await this.persist(internal, workspace);
    this.tryDispatch();
    return job;
  }

  /** Cancel a running or queued job. Cancelled queued jobs do not spawn. */
  async cancel(id: string): Promise<Job | null> {
    const internal = this.jobs.get(id);
    if (!internal) return null;
    if (internal.job.status === "succeeded" || internal.job.status === "failed" || internal.job.status === "cancelled") {
      return internal.job;
    }
    internal.cancelRequested = true;
    if (internal.proc) {
      try {
        internal.proc.kill("SIGINT");
      } catch {
        // ignore — the close handler will clean up.
      }
    } else {
      internal.job.status = "cancelled";
      internal.job.updated_at = new Date().toISOString();
      const ws = this.workspaces.get(internal.job.workspace_id);
      if (ws) await this.persist(internal, ws);
    }
    return internal.job;
  }

  /** Wait until every job has terminated (used in tests). */
  async waitIdle(): Promise<void> {
    while (this.active > 0 || this.list().some((j) => j.status === "queued")) {
      const pending = this.list()
        .map((j) => this.jobs.get(j.id)?.done)
        .filter((p): p is Promise<void> => Boolean(p));
      if (pending.length === 0) return;
      // eslint-disable-next-line no-await-in-loop
      await Promise.race(pending);
    }
  }

  /** Hydrate persisted jobs for a workspace. Idempotent. */
  async hydrate(workspace: StudioWorkspace): Promise<void> {
    const dir = this.persistRootFor(workspace);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".json")) continue;
      const file = path.join(dir, entry);
      try {
        const raw = await readFile(file, "utf8");
        const parsed = JSON.parse(raw) as Job;
        if (this.jobs.has(parsed.id)) continue;
        // Persisted jobs are terminal-or-stale — surface them as cancelled
        // if they were left running across a restart.
        if (parsed.status === "queued" || parsed.status === "running") {
          parsed.status = "cancelled";
          parsed.warnings = [
            ...(parsed.warnings ?? []),
            "studio restart cancelled this job; resubmit if needed"
          ];
        }
        const internal: JobInternal = { job: parsed, proc: null, cancelRequested: false };
        this.jobs.set(parsed.id, internal);
        this.orderedIds.push(parsed.id);
      } catch {
        // ignore unreadable persistence rows
      }
    }
  }

  private tryDispatch(): void {
    while (this.active < this.concurrency) {
      const next = this.orderedIds
        .map((id) => this.jobs.get(id))
        .find((entry): entry is JobInternal => entry !== undefined && entry.job.status === "queued");
      if (!next) return;
      this.startJob(next);
    }
  }

  private startJob(internal: JobInternal): void {
    if (internal.cancelRequested) {
      internal.job.status = "cancelled";
      internal.job.updated_at = new Date().toISOString();
      const ws = this.workspaces.get(internal.job.workspace_id);
      if (ws) void this.persist(internal, ws);
      return;
    }
    const workspace = this.workspaces.get(internal.job.workspace_id);
    if (!workspace) {
      internal.job.status = "failed";
      internal.job.exit_code = -1;
      internal.job.updated_at = new Date().toISOString();
      internal.job.warnings.push("workspace went away before the job started");
      return;
    }
    this.active += 1;
    internal.job.status = "running";
    internal.job.updated_at = new Date().toISOString();
    void this.persist(internal, workspace);
    const argvWithoutBinary = internal.job.argv.slice(1);
    const proc = spawn(this.cliBin.node, [this.cliBin.entry, ...argvWithoutBinary], {
      cwd: internal.job.cwd,
      env: {
        ...process.env,
        // Make the child non-interactive in case any command tries to prompt.
        CI: process.env.CI ?? "1",
        FORCE_COLOR: "0"
      },
      shell: false,
      windowsHide: true
    });
    internal.proc = proc;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer = appendTail(stdoutBuffer, chunk.toString("utf8"));
      internal.job.stdout_tail = stdoutBuffer;
      internal.job.updated_at = new Date().toISOString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer = appendTail(stderrBuffer, chunk.toString("utf8"));
      internal.job.stderr_tail = stderrBuffer;
      internal.job.updated_at = new Date().toISOString();
    });
    internal.done = new Promise<void>((resolve) => {
      proc.on("close", (code, signal) => {
        internal.proc = null;
        internal.job.exit_code = typeof code === "number" ? code : signal ? -1 : null;
        if (internal.cancelRequested) {
          internal.job.status = "cancelled";
        } else if (typeof code === "number" && code === 0) {
          internal.job.status = "succeeded";
          if (internal.job.expected_artifact) {
            const fullPath = path.resolve(internal.job.cwd, internal.job.expected_artifact);
            if (existsSync(fullPath)) {
              internal.job.artifact_paths.push(internal.job.expected_artifact);
            }
          }
        } else {
          internal.job.status = "failed";
        }
        internal.job.updated_at = new Date().toISOString();
        this.active = Math.max(0, this.active - 1);
        const ws = this.workspaces.get(internal.job.workspace_id);
        if (ws) void this.persist(internal, ws);
        resolve();
        this.tryDispatch();
      });
      proc.on("error", (err) => {
        internal.proc = null;
        internal.job.warnings.push(`spawn failed: ${(err as Error).message ?? String(err)}`);
        internal.job.status = "failed";
        internal.job.exit_code = -1;
        internal.job.updated_at = new Date().toISOString();
        this.active = Math.max(0, this.active - 1);
        const ws = this.workspaces.get(internal.job.workspace_id);
        if (ws) void this.persist(internal, ws);
        resolve();
        this.tryDispatch();
      });
    });
  }

  private async persist(internal: JobInternal, workspace: StudioWorkspace): Promise<void> {
    const dir = this.persistRootFor(workspace);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, `${internal.job.id}.json`),
        JSON.stringify(internal.job, null, 2),
        "utf8"
      );
    } catch (err) {
      internal.job.warnings.push(`persist failed: ${(err as Error).message ?? String(err)}`);
    }
  }
}

interface BuiltArgv {
  argv: string[];
  outputPath: string | null;
  expectedArtifact: string | null;
  notes: string[];
}

function buildArgvForKind(
  kind: JobKind,
  params: Record<string, string>,
  workspace: StudioWorkspace
): { argv: BuiltArgv["argv"]; outputPath: string | null; expectedArtifact: string | null; notes: string[] } | { error: JobValidationError } {
  switch (kind) {
    case "run": {
      const argv: string[] = ["run"];
      const scenario = (params.scenario ?? "").trim();
      let expected: string | null = null;
      if (scenario.length > 0) {
        ensureSafeRelative(scenario, "scenario");
        argv.push(scenario);
        expected = scenario.endsWith(".json")
          ? scenario
          : `.riptide/runs/${sanitizeForPath(scenario)}/simulation-result.json`;
      } else {
        expected = ".riptide/run-collection.json";
      }
      argv.push("--quiet");
      return {
        argv,
        outputPath: ".riptide/runs/",
        expectedArtifact: expected,
        notes: scenario.length === 0 ? ["No scenario filter — runs every scenario discovered under .riptide/scenarios/."] : []
      };
    }
    case "replay": {
      const config = (params.config ?? "").trim();
      if (!config) {
        return {
          error: validationError(400, "missing_param", "replay requires `config` (path to replay-config.json)")
        };
      }
      ensureSafeRelative(config, "config");
      return {
        argv: ["replay", config, "--quiet"],
        outputPath: path.dirname(config),
        expectedArtifact: path.join(path.dirname(config), "simulation-result.json"),
        notes: []
      };
    }
    case "campaign-validate":
    case "campaign-plan":
    case "campaign-run": {
      const campaign = (params.campaign ?? "").trim();
      if (!campaign) {
        return {
          error: validationError(400, "missing_param", `${kind} requires \`campaign\` (path to <name>.campaign.toml)`)
        };
      }
      ensureSafeRelative(campaign, "campaign");
      const sub = kind === "campaign-validate" ? "validate" : kind === "campaign-plan" ? "plan" : "run";
      const argv = ["campaign", sub, campaign];
      const notes = kind === "campaign-run" ? ["Campaign run can spawn many child runs and may take several minutes."] : [];
      if (kind === "campaign-run") {
        const harness = resolveCampaignHarnessParam(params, workspace);
        if ("error" in harness) return { error: harness.error };
        if (harness.path) {
          argv.push("--harness", harness.path);
          notes.push(harness.note);
        }
      }
      return {
        argv,
        outputPath: kind === "campaign-run" ? ".riptide/campaigns/" : null,
        expectedArtifact: kind === "campaign-run" ? ".riptide/campaigns/" : null,
        notes
      };
    }
    case "review": {
      const pack = (params.pack ?? params.collection ?? "").trim();
      if (!pack) {
        return {
          error: validationError(
            400,
            "missing_param",
            "review requires `pack` (path to a pack, campaign root, retained case, or guided-sim artifact)"
          )
        };
      }
      ensureSafeRelative(pack, "pack");
      const out = (params.out ?? "").trim();
      const argv = ["review", pack, "--quiet"];
      if (out) {
        ensureSafeRelative(out, "out");
        argv.push("--out", out);
      }
      return {
        argv,
        outputPath: out || null,
        expectedArtifact: out || null,
        notes: []
      };
    }
    case "readiness": {
      // `riptide readiness` requires either a path or --case-studies; we
      // pin the workspace as the positional path so artifacts always
      // describe the workspace Studio is currently inspecting.
      const argv = ["readiness", ".", "--json"];
      const out = (params.out ?? ".riptide/readiness").trim();
      ensureSafeRelative(out, "out");
      argv.push("--out", out);
      return {
        argv,
        outputPath: out,
        expectedArtifact: `${out}/readiness.json`,
        notes: ["Readiness emits a JSON + Markdown report under the --out directory."]
      };
    }
    default:
      return {
        error: validationError(400, "invalid_kind", `unsupported job kind: ${kind}`)
      };
  }
}

function resolveCampaignHarnessParam(
  params: Record<string, string>,
  workspace: StudioWorkspace
): { path: string | null; note: string } | { error: JobValidationError } {
  const requested = (params.harness ?? "").trim();
  if (requested.length > 0) {
    try {
      ensureSafeRelative(requested, "harness");
    } catch (err) {
      return {
        error: validationError(400, "invalid_param", (err as Error).message)
      };
    }
    return {
      path: requested,
      note: `Using harness ${requested}.`
    };
  }

  const defaultHarness = ".riptide/harness";
  if (
    existsSync(path.join(workspace.path, defaultHarness, "Cargo.toml")) ||
    existsSync(path.join(workspace.path, defaultHarness))
  ) {
    return {
      path: defaultHarness,
      note: "Detected .riptide/harness and attached it to the campaign run."
    };
  }

  return {
    path: null,
    note: ""
  };
}

function ensureSafeRelative(rel: string, label: string): void {
  if (!rel) return;
  if (rel.includes("\0")) throw new Error(`${label} contains a NUL byte`);
  if (path.isAbsolute(rel)) {
    throw new Error(`${label} must be a workspace-relative path, not an absolute path`);
  }
  const normalized = path.normalize(rel);
  if (normalized.split(path.sep).includes("..")) {
    throw new Error(`${label} must not escape the workspace root`);
  }
  if (/[<>|`$;&]/.test(rel)) {
    throw new Error(`${label} contains shell metacharacters`);
  }
}

function workspaceSlug(workspace: StudioWorkspace): string {
  if (workspace.id !== "current") return workspace.id;
  return path.basename(workspace.path);
}

function sanitizeForPath(name: string): string {
  return name.replace(/[^A-Za-z0-9._/-]/g, "-");
}

function validationError(status: number, code: string, message: string): JobValidationError {
  return { status, payload: { error: code, message } };
}

export function isValidationError(value: unknown): value is JobValidationError {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    "payload" in value &&
    typeof (value as { status: unknown }).status === "number"
  );
}

function appendTail(existing: string, chunk: string): string {
  const next = existing + chunk;
  if (Buffer.byteLength(next, "utf8") <= TAIL_BYTES) return next;
  return next.slice(-TAIL_BYTES);
}

function quoteArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function defaultCliBin(): { node: string; entry: string } {
  // dist layout when packaged: cli/dist/src/studio/jobs.js -> cli/dist/src/index.js
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "..", "index.js"),
    path.resolve(here, "..", "..", "src", "index.js")
  ];
  const entry = candidates.find((c) => existsSync(c)) ?? candidates[0] ?? "";
  return { node: process.execPath, entry };
}
