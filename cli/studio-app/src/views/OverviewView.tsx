import type { ArtifactIndex, JobListPayload, Workspace } from "../api";
import type { ViewKey } from "../components/Sidebar";
import { StatusPill } from "../components/StatusPill";

interface Props {
  workspace: Workspace;
  artifacts: ArtifactIndex | null;
  artifactsError: string | null;
  jobs: JobListPayload | null;
  openArtifactReport: (id: string) => void;
  setView: (view: ViewKey) => void;
}

export function OverviewView({
  workspace,
  artifacts,
  artifactsError,
  jobs,
  openArtifactReport,
  setView
}: Props) {
  const collection = artifacts?.artifacts.find((a) => a.kind === "run-collection");
  const recentRuns = artifacts
    ? artifacts.artifacts
        .filter((a) => a.kind === "run")
        .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
        .slice(0, 5)
    : [];
  const recentReports = artifacts
    ? artifacts.artifacts
        .filter((a) =>
          ["markdown-summary", "readiness-report", "campaign-root"].includes(a.kind)
        )
        .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
        .slice(0, 5)
    : [];
  const queuedJobs = jobs?.jobs.filter((j) => j.status === "queued" || j.status === "running") ?? [];

  return (
    <>
      <div className="rt-page-kicker">WORKSPACE</div>
      <h1>{workspace.label}</h1>
      <p>
        <code className="rt-code-inline">{workspace.path}</code>
        {workspace.source === "case-study" ? (
          <>
            {" "}
            <StatusPill text="Case study" tone="info" />
          </>
        ) : null}
      </p>

      {workspace.warnings.length > 0 ? <WarningList warnings={workspace.warnings} /> : null}

      {artifactsError ? (
        <div className="rt-card">
          <h3>Artifacts unavailable</h3>
          <p>{artifactsError}</p>
        </div>
      ) : null}

      {!workspace.has_riptide ? (
        <div className="rt-empty">
          <strong>No .riptide/ folder yet.</strong>
          Run <code className="rt-code-inline">riptide init</code> in this workspace to scaffold
          adapters, scenarios, and runs. Studio refreshes automatically.
        </div>
      ) : null}

      <div className="rt-grid-cols-2">
        <div className="rt-card">
          <div className="rt-page-kicker">LATEST RUN COLLECTION</div>
          {collection ? (
            <>
              <h3>{collection.label}</h3>
              <div className="rt-meta">{collection.relative_path}</div>
              <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
                <StatusPill text={collection.status} />
                <StatusPill text={collection.verdict} />
                <StatusPill text={collection.coverage} tone="info" />
                <StatusPill text={collection.confidence} tone="info" />
              </div>
              <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                <button className="rt-btn" type="button" onClick={() => openArtifactReport(collection.id)}>
                  Open report
                </button>
                <button
                  className="rt-btn rt-btn--ghost"
                  type="button"
                  onClick={() => setView("dashboard")}
                >
                  Open dashboard
                </button>
              </div>
            </>
          ) : (
            <div className="rt-empty">
              <strong>No run collection yet.</strong>
              Run <code className="rt-code-inline">riptide run</code> to produce one.
            </div>
          )}
        </div>

        <div className="rt-card">
          <div className="rt-page-kicker">JOB QUEUE</div>
          {queuedJobs.length === 0 ? (
            <div className="rt-empty">
              <strong>No active jobs.</strong>
              Open <code className="rt-code-inline">Launch jobs</code> to plan or queue a Riptide
              command.
            </div>
          ) : (
            <ul className="rt-warning-list">
              {queuedJobs.map((j) => (
                <li key={j.id}>
                  <strong>{j.kind}</strong> — {j.status} · {j.argv.slice(0, 4).join(" ")}…
                </li>
              ))}
            </ul>
          )}
          <button
            className="rt-btn rt-btn--accent"
            type="button"
            style={{ marginTop: 8 }}
            onClick={() => setView("launch")}
          >
            Plan or launch a job
          </button>
        </div>
      </div>

      <h2>Recent runs</h2>
      {recentRuns.length === 0 ? (
        <div className="rt-empty">
          <strong>No runs found.</strong>
          Runs appear here after <code className="rt-code-inline">riptide run</code> writes
          <code className="rt-code-inline"> .riptide/runs/&lt;scenario&gt;/</code>.
        </div>
      ) : (
        <div className="rt-table-wrap">
          <table className="rt-table">
            <thead>
              <tr>
                <th>Scenario</th>
                <th>Status</th>
                <th>Verdict</th>
                <th>Invariant fires</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {recentRuns.map((r) => (
                <tr key={r.id}>
                  <td>{r.label}</td>
                  <td>
                    <StatusPill text={r.status} />
                  </td>
                  <td>
                    <StatusPill text={r.verdict} />
                  </td>
                  <td className="rt-mono">{r.invariant_fire_count ?? 0}</td>
                  <td className="rt-mono">{relTime(r.updated_at)}</td>
                  <td>
                    <button className="rt-btn rt-btn--ghost" type="button" onClick={() => openArtifactReport(r.id)}>
                      Report
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Recent reports & summaries</h2>
      {recentReports.length === 0 ? (
        <div className="rt-empty">
          <strong>No summaries yet.</strong>
          Markdown reports appear under <code className="rt-code-inline">.riptide/</code>,
          campaign roots under <code className="rt-code-inline">.riptide/campaigns/</code>, and
          readiness reports under <code className="rt-code-inline">.riptide/readiness/</code>.
        </div>
      ) : (
        <div className="rt-grid-cols-2">
          {recentReports.map((r) => (
            <div className="rt-card" key={r.id}>
              <h3>{r.label}</h3>
              <div className="rt-meta">{r.relative_path}</div>
              <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
                <StatusPill text={r.kind.replace(/-/g, " ")} tone="info" />
                <StatusPill text={r.verdict} />
              </div>
              <div style={{ marginTop: 8 }}>
                <button className="rt-btn rt-btn--ghost" type="button" onClick={() => openArtifactReport(r.id)}>
                  Open
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function WarningList({ warnings }: { warnings: { message: string; next_action: string }[] }) {
  return (
    <ul className="rt-warning-list" style={{ marginBottom: 12 }}>
      {warnings.map((w, i) => (
        <li key={i}>
          <strong>{w.message}.</strong> {w.next_action}
        </li>
      ))}
    </ul>
  );
}

function relTime(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const delta = Date.now() - t;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return new Date(t).toISOString().slice(0, 10);
}
