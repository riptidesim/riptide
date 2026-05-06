import { useEffect, useMemo, useState } from "react";

import {
  api,
  type ArtifactIndex,
  type Job,
  type JobKind,
  type JobListPayload,
  type JobPlanPreview,
  type Workspace
} from "../api";
import { StatusPill } from "../components/StatusPill";

interface Props {
  workspace: Workspace;
  artifacts: ArtifactIndex | null;
  jobs: JobListPayload | null;
  refreshJobs: () => Promise<void>;
}

interface JobKindSpec {
  kind: JobKind;
  label: string;
  helper: string;
  fields: Array<{
    name: string;
    label: string;
    placeholder?: string;
    helper?: string;
    optional?: boolean;
  }>;
}

const KINDS: JobKindSpec[] = [
  {
    kind: "run",
    label: "riptide run",
    helper: "Runs every scenario under .riptide/scenarios/, or a glob/file when scenario is set.",
    fields: [
      {
        name: "scenario",
        label: "Scenario or glob",
        placeholder: "(empty = run all)",
        optional: true,
        helper: "Passed positionally. Glob match or `.json` path."
      }
    ]
  },
  {
    kind: "replay",
    label: "riptide replay",
    helper: "Deterministically replays a declared trajectory from a replay-config JSON.",
    fields: [
      {
        name: "config",
        label: "Replay config path",
        placeholder: ".riptide/replays/<name>/replay-config.json"
      }
    ]
  },
  {
    kind: "campaign-validate",
    label: "riptide campaign validate",
    helper: "Validate a campaign TOML before planning or execution.",
    fields: [
      {
        name: "campaign",
        label: "Campaign TOML",
        placeholder: ".riptide/campaigns/<name>.campaign.toml"
      }
    ]
  },
  {
    kind: "campaign-plan",
    label: "riptide campaign plan",
    helper: "Expand a campaign into a deterministic run plan and write artifacts.",
    fields: [
      {
        name: "campaign",
        label: "Campaign TOML",
        placeholder: ".riptide/campaigns/<name>.campaign.toml"
      }
    ]
  },
  {
    kind: "campaign-run",
    label: "riptide campaign run",
    helper: "Execute the campaign and retain selected runs into .riptide/campaigns/<id>/.",
    fields: [
      {
        name: "campaign",
        label: "Campaign TOML",
        placeholder: ".riptide/campaigns/<name>.campaign.toml"
      }
    ]
  },
  {
    kind: "review",
    label: "riptide review",
    helper: "Validate an evidence pack, campaign root, retained case, or guided-sim artifact and emit reviewer markdown.",
    fields: [
      {
        name: "pack",
        label: "Pack or artifact path",
        placeholder: ".riptide/pack/<scenario>"
      },
      {
        name: "out",
        label: "Output markdown path",
        placeholder: ".riptide/review.md",
        optional: true
      }
    ]
  },
  {
    kind: "readiness",
    label: "riptide readiness",
    helper: "Inspect local readiness evidence and emit JSON + Markdown into reports/case-study-readiness/.",
    fields: [
      {
        name: "out",
        label: "Output directory",
        placeholder: "reports/case-study-readiness",
        optional: true
      }
    ]
  }
];

export function LaunchView({ workspace, artifacts, jobs, refreshJobs }: Props) {
  const [kind, setKind] = useState<JobKind>("run");
  const [params, setParams] = useState<Record<string, string>>({});
  const [plan, setPlan] = useState<JobPlanPreview | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);

  const spec = useMemo(() => KINDS.find((k) => k.kind === kind)!, [kind]);

  // Reset params when the kind changes.
  useEffect(() => {
    setParams({});
    setPlan(null);
    setPlanError(null);
    setLaunchError(null);
  }, [kind, workspace.id]);

  // Poll the selected job for live status/log updates.
  useEffect(() => {
    if (!selectedJobId) {
      setSelectedJob(null);
      return;
    }
    let cancelled = false;
    let timer: number;
    async function tick() {
      try {
        const { job } = await api.job(selectedJobId!);
        if (cancelled) return;
        setSelectedJob(job);
        setJobError(null);
        if (job.status === "queued" || job.status === "running") {
          timer = window.setTimeout(tick, 1500);
        }
      } catch (err) {
        if (!cancelled) {
          setJobError((err as Error).message);
          timer = window.setTimeout(tick, 5000);
        }
      }
    }
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [selectedJobId]);

  async function handlePlan() {
    setPlanning(true);
    setPlanError(null);
    setLaunchError(null);
    try {
      const { plan } = await api.planJob(workspace.id, kind, params);
      setPlan(plan);
    } catch (err) {
      setPlanError((err as Error).message);
      setPlan(null);
    } finally {
      setPlanning(false);
    }
  }

  async function handleLaunch() {
    setLaunching(true);
    setLaunchError(null);
    try {
      const { job } = await api.launchJob(workspace.id, kind, params);
      setSelectedJobId(job.id);
      await refreshJobs();
      setPlan(null);
    } catch (err) {
      setLaunchError((err as Error).message);
    } finally {
      setLaunching(false);
    }
  }

  async function handleCancel(id: string) {
    try {
      await api.cancelJob(id);
      await refreshJobs();
      if (id === selectedJobId) {
        const { job } = await api.job(id);
        setSelectedJob(job);
      }
    } catch (err) {
      setJobError((err as Error).message);
    }
  }

  const runArtifacts = artifacts?.artifacts.filter((a) => a.kind === "run") ?? [];
  const campaignFiles = artifacts?.artifacts.filter((a) => a.kind === "campaign-input") ?? [];

  return (
    <>
      <div className="rt-page-kicker">LAUNCH JOBS</div>
      <h1>Plan and queue local Riptide jobs</h1>
      <p>
        Studio queues jobs as <code className="rt-code-inline">spawn()</code> calls with explicit
        argv and a workspace cwd. Generic shell, push, and publish commands are rejected at the
        server. The full command and target path are shown before launch.
      </p>

      {!workspace.has_riptide ? (
        <div className="rt-empty">
          <strong>No .riptide/ folder.</strong>
          Initialise the workspace before queuing a job.
        </div>
      ) : null}

      <div className="rt-card">
        <h3>Plan a job</h3>
        <div className="rt-toolbar">
          <select className="rt-select" value={kind} onChange={(e) => setKind(e.target.value as JobKind)}>
            {KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
          <span className="rt-meta">{spec.helper}</span>
        </div>

        {spec.fields.map((field) => (
          <div className="rt-form-row" key={field.name}>
            <label htmlFor={`field-${field.name}`}>
              {field.label}
              {field.optional ? " (optional)" : ""}
            </label>
            <input
              id={`field-${field.name}`}
              className="rt-input"
              placeholder={field.placeholder}
              value={params[field.name] ?? ""}
              onChange={(e) => setParams((prev) => ({ ...prev, [field.name]: e.target.value }))}
              list={
                field.name === "scenario"
                  ? "rt-launch-scenarios"
                  : field.name === "campaign"
                    ? "rt-launch-campaigns"
                    : undefined
              }
            />
            {field.helper ? <span className="rt-meta">{field.helper}</span> : null}
          </div>
        ))}

        <datalist id="rt-launch-scenarios">
          {runArtifacts.map((r) => (
            <option key={r.id} value={r.label} />
          ))}
        </datalist>
        <datalist id="rt-launch-campaigns">
          {campaignFiles.map((c) => (
            <option key={c.id} value={c.relative_path} />
          ))}
        </datalist>

        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          <button className="rt-btn" type="button" onClick={handlePlan} disabled={planning}>
            {planning ? "Planning…" : "Preview command"}
          </button>
          {plan ? (
            <button className="rt-btn rt-btn--accent" type="button" onClick={handleLaunch} disabled={launching}>
              {launching ? "Queuing…" : "Queue this job"}
            </button>
          ) : null}
        </div>

        {planError ? (
          <div className="rt-empty" style={{ marginTop: 12 }}>
            <strong>Plan failed.</strong>
            {planError}
          </div>
        ) : null}
        {launchError ? (
          <div className="rt-empty" style={{ marginTop: 12 }}>
            <strong>Launch failed.</strong>
            {launchError}
          </div>
        ) : null}

        {plan ? (
          <div className="rt-detail-panel">
            <h3>Will execute</h3>
            <div className="rt-job-meta">
              <span>
                <strong>cwd</strong> {plan.cwd}
              </span>
              <span>
                <strong>kind</strong> {plan.kind}
              </span>
              {plan.output_path ? (
                <span>
                  <strong>output</strong> {plan.output_path}
                </span>
              ) : null}
              {plan.expected_artifact ? (
                <span>
                  <strong>expected</strong> {plan.expected_artifact}
                </span>
              ) : null}
            </div>
            <pre className="rt-code-block" style={{ marginTop: 8 }}>{plan.command_string}</pre>
            {plan.notes.length > 0 ? (
              <ul className="rt-warning-list" style={{ marginTop: 8 }}>
                {plan.notes.map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>

      <h2>Job history</h2>
      {(jobs?.jobs ?? []).length === 0 ? (
        <div className="rt-empty">
          <strong>No jobs queued from Studio yet.</strong>
          Use the planner above to queue your first command.
        </div>
      ) : (
        <div className="rt-table-wrap">
          <table className="rt-table">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Status</th>
                <th>Created</th>
                <th>Updated</th>
                <th>Workspace</th>
                <th>Command</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(jobs?.jobs ?? []).map((j) => (
                <tr
                  key={j.id}
                  className="rt-row-clickable"
                  onClick={() => setSelectedJobId(j.id)}
                  style={selectedJobId === j.id ? { background: "var(--rt-slate-2)" } : undefined}
                >
                  <td>{j.kind}</td>
                  <td>
                    <StatusPill text={j.status} tone={statusTone(j.status)} />
                    {j.exit_code !== null ? (
                      <span className="rt-meta" style={{ marginLeft: 8 }}>
                        exit {j.exit_code}
                      </span>
                    ) : null}
                  </td>
                  <td className="rt-mono">{j.created_at.slice(11, 19)}</td>
                  <td className="rt-mono">{j.updated_at.slice(11, 19)}</td>
                  <td className="rt-mono">{j.workspace_id}</td>
                  <td className="rt-mono">{j.argv.slice(0, 5).join(" ")}…</td>
                  <td>
                    {j.status === "queued" || j.status === "running" ? (
                      <button
                        className="rt-btn rt-btn--danger"
                        type="button"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          void handleCancel(j.id);
                        }}
                      >
                        Cancel
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedJob ? (
        <div className="rt-card" style={{ marginTop: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <div>
              <h3>{selectedJob.kind}</h3>
              <div className="rt-meta">
                {selectedJob.id} · {selectedJob.workspace_id}
              </div>
            </div>
            <StatusPill text={selectedJob.status} tone={statusTone(selectedJob.status)} />
          </div>
          <div className="rt-job-meta" style={{ marginTop: 8 }}>
            <span>
              <strong>cwd</strong> {selectedJob.cwd}
            </span>
            {selectedJob.output_path ? (
              <span>
                <strong>output</strong> {selectedJob.output_path}
              </span>
            ) : null}
            {selectedJob.expected_artifact ? (
              <span>
                <strong>expected</strong> {selectedJob.expected_artifact}
              </span>
            ) : null}
            {selectedJob.exit_code !== null ? (
              <span>
                <strong>exit</strong> {selectedJob.exit_code}
              </span>
            ) : null}
          </div>
          <pre className="rt-code-block" style={{ marginTop: 8 }}>{selectedJob.argv.join(" ")}</pre>
          <h2 style={{ marginTop: 16, fontSize: 13 }}>stdout (tail)</h2>
          <pre className="rt-log-pane">{selectedJob.stdout_tail || "(no output yet)"}</pre>
          <h2 style={{ marginTop: 16, fontSize: 13 }}>stderr (tail)</h2>
          <pre className="rt-log-pane rt-log-pane--err">{selectedJob.stderr_tail || "(empty)"}</pre>
          {jobError ? (
            <div className="rt-empty" style={{ marginTop: 8 }}>
              <strong>Job poll error.</strong>
              {jobError}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function statusTone(status: Job["status"]): "pass" | "fail" | "warn" | "info" | "neutral" {
  switch (status) {
    case "succeeded":
      return "pass";
    case "failed":
      return "fail";
    case "cancelled":
      return "warn";
    case "running":
      return "info";
    case "queued":
      return "info";
    default:
      return "neutral";
  }
}
