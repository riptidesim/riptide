import type { ArtifactIndex, Health, JobListPayload, Workspace } from "../api";

interface Props {
  workspaces: Workspace[];
  workspaceId: string;
  onSelectWorkspace: (id: string) => void;
  health: Health | null;
  artifacts: ArtifactIndex | null;
  jobs: JobListPayload | null;
}

export function TopBar({ workspaces, workspaceId, onSelectWorkspace, health, artifacts, jobs }: Props) {
  const artifactCount = artifacts?.artifacts.length ?? 0;
  const queued = jobs?.jobs.filter((j) => j.status === "queued").length ?? 0;
  const running = jobs?.jobs.filter((j) => j.status === "running").length ?? 0;
  const failed = jobs?.jobs.filter((j) => j.status === "failed").length ?? 0;
  const verdict = dominantStatus(artifacts);

  return (
    <header className="rt-topbar">
      <span className="rt-brand">
        <strong>RIPTIDE</strong>&nbsp;STUDIO
      </span>
      <div className="rt-workspace-pick">
        <label htmlFor="rt-workspace-select">Workspace</label>
        <select
          id="rt-workspace-select"
          className="rt-select"
          value={workspaceId}
          onChange={(e) => onSelectWorkspace(e.target.value)}
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.label} {w.source === "case-study" ? "(case study)" : ""}
            </option>
          ))}
        </select>
      </div>
      <div className="rt-status-strip">
        <span className="rt-stat">
          <span
            className={`rt-dot ${
              !health ? "" : health.workspace_count > 0 ? "rt-dot--ok" : "rt-dot--warn"
            }`}
          />
          Server <strong>{health ? "OK" : "…"}</strong>
        </span>
        <span className="rt-stat">
          Artifacts <strong>{artifactCount}</strong>
        </span>
        <span className="rt-stat">
          Verdict <strong>{verdict}</strong>
        </span>
        <span className="rt-stat">
          Jobs{" "}
          <strong>
            {running}R · {queued}Q · {failed}F
          </strong>
        </span>
      </div>
    </header>
  );
}

function dominantStatus(artifacts: ArtifactIndex | null): string {
  if (!artifacts) return "—";
  const collection = artifacts.artifacts.find((a) => a.kind === "run-collection");
  if (collection?.verdict) return collection.verdict.toUpperCase();
  if (collection?.status) return collection.status.toUpperCase();
  const runs = artifacts.artifacts.filter((a) => a.kind === "run");
  if (runs.length === 0) return "—";
  const failed = runs.filter((r) => r.status === "fail").length;
  return failed > 0 ? `${failed}/${runs.length} FAIL` : "PASS";
}
