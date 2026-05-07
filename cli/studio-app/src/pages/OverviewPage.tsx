import { useEffect, useMemo, useState, type ReactNode } from "react";

import { api } from "../api";
import type { Job, StudioArtifactEntry } from "../studioTypes";
import { Icon } from "../ui/Icon";
import { EmptyState, Kicker, PageLabel, Pill, type PillKind } from "../ui/primitives";
import type { PageId } from "../shell/types";

interface OverviewProps {
  workspaceId: string;
  onNavigate: (id: PageId) => void;
}

export function OverviewPage({ workspaceId, onNavigate }: OverviewProps) {
  const [artifacts, setArtifacts] = useState<StudioArtifactEntry[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setArtifacts([]);
    setJobs([]);
    Promise.all([api.artifacts(workspaceId), api.jobs.list(workspaceId)])
      .then(([artifactRes, jobRes]) => {
        if (cancelled) return;
        setArtifacts(artifactRes.artifacts);
        setJobs(jobRes.jobs.filter((job) => job.workspace_id === workspaceId));
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const runningJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");
  const campaignRoots = artifacts.filter((artifact) => artifact.kind === "campaign-root");
  const campaignInputs = artifacts.filter((artifact) => artifact.kind === "campaign-input");
  const runs = artifacts.filter((artifact) => artifact.kind === "run");
  const reports = artifacts.filter((artifact) =>
    ["run-collection", "last-run", "run", "campaign-root", "pack", "guided-sim", "readiness-report", "markdown-summary"].includes(artifact.kind)
  );
  const verdictMix = useMemo(() => summarizeVerdicts(artifacts), [artifacts]);

  return (
    <div>
      <PageLabel>DASHBOARD</PageLabel>
      {loading && <InlineCard icon="refresh" title="Loading workspace" body="Fetching artifacts and jobs from the Studio API." />}
      {error && <InlineCard icon="plug" title="Studio API error" body={error} />}
      {!loading && !error && artifacts.length === 0 && jobs.length === 0 && (
        <div className="card" style={{ padding: 0 }}>
          <EmptyState
            icon="plug"
            title="No workspace artifacts yet"
            body="Run a scenario or configure a campaign and the Overview will populate from .riptide artifacts."
            ctaLabel="Open Agent chat"
            onCta={() => onNavigate("handoff")}
          />
        </div>
      )}
      {!loading && !error && (artifacts.length > 0 || jobs.length > 0) && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginBottom: 18 }}>
            <MetricCard label="RUNS" value={String(runs.length)} sub={`${reports.length} report-capable artifacts`} />
            <MetricCard label="CAMPAIGNS" value={String(campaignInputs.length + campaignRoots.length)} sub={`${campaignRoots.length} completed roots`} />
            <MetricCard label="JOBS" value={String(runningJobs.length)} sub="queued or running now" />
            <VerdictMetricCard summary={verdictMix} />
          </div>

          <section style={{ marginBottom: 18 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
              <Kicker>ACTIVE JOBS</Kicker>
              <button className="btn btn--ghost btn--sm" onClick={() => onNavigate("jobs")}>
                Open queue
                <Icon name="chevron" size={12} />
              </button>
            </div>
            {runningJobs.length === 0 ? (
              <DashedGrid label="No active job" action="Queue a run from Reports" />
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                {runningJobs.slice(0, 4).map((job) => (
                  <div key={job.id} className="simcard">
                    <div className="simcard__top">
                      <span className={`dot dot--${job.status === "running" ? "running" : "queued"}`} />
                      <span className="simcard__name">{job.argv.join(" ")}</span>
                    </div>
                    <div className="simcard__time">{job.id}</div>
                    <div className="simcard__divider" />
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <Pill kind={pillForJob(job.status)} dot={job.status === "running"}>{job.status.toUpperCase()}</Pill>
                      <span style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)" }}>{formatTime(job.updated_at)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <div className="card">
            <div className="card__head" style={{ alignItems: "center" }}>
              <div>
                <Kicker style={{ marginBottom: 4 }}>WORKSPACE GRAPH</Kicker>
                <div className="card__sub">Live artifact inventory for this workspace.</div>
              </div>
              <button className="btn btn--ghost btn--sm" onClick={() => onNavigate("reports")}>
                View artifacts
                <Icon name="external" size={12} />
              </button>
            </div>
            <div className="card__body" style={{ paddingTop: 0 }}>
              <PipelineRow label="Adapter" count={artifacts.filter((artifact) => artifact.kind === "adapter").length} onClick={() => onNavigate("adapter")} />
              <PipelineRow
                label="Campaigns"
                count={campaignInputs.length + campaignRoots.length}
                sub={`${campaignInputs.length} defined · ${campaignRoots.length} run`}
                onClick={() => onNavigate("campaigns")}
              />
              <PipelineRow label="Runs" count={runs.length} onClick={() => onNavigate("reports")} />
              <PipelineRow label="Reports" count={reports.length} onClick={() => onNavigate("reports")} last />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MetricCard({ label, value, sub }: { label: string; value: ReactNode; sub: ReactNode }) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <Kicker style={{ marginBottom: 8 }}>{label}</Kicker>
      <div style={{ font: '500 30px "IBM Plex Mono"', color: "var(--rt-off-white)", lineHeight: 1 }}>{value}</div>
      <div style={{ font: "400 12px Inter", color: "var(--rt-fog-dim)", marginTop: 6 }}>{sub}</div>
    </div>
  );
}

function VerdictMetricCard({ summary }: { summary: VerdictSummary }) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <Kicker style={{ marginBottom: 8 }}>VERDICTS</Kicker>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 32 }}>
        <div style={{ font: '500 30px "IBM Plex Mono"', color: "var(--rt-off-white)", lineHeight: 1 }}>
          {summary.count}
        </div>
        <Pill kind={summary.kind}>{summary.label}</Pill>
      </div>
      <div style={{ font: "400 12px Inter", color: "var(--rt-fog-dim)", marginTop: 6 }}>{summary.detail}</div>
    </div>
  );
}

function InlineCard({ icon, title, body }: { icon: "refresh" | "plug"; title: string; body: string }) {
  return (
    <div className="card" style={{ padding: 0 }}>
      <EmptyState icon={icon} title={title} body={body} />
    </div>
  );
}

function DashedGrid({ label, action }: { label: string; action: string }) {
  return (
    <div className="card" style={{ padding: "26px 18px", display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
      {[0, 1, 2, 3].map((idx) => (
        <div
          key={idx}
          style={{
            minHeight: 110,
            border: "1px dashed var(--rt-slate-line)",
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            gap: 8,
            color: "var(--rt-fog-dim)",
            fontSize: 12
          }}
        >
          <Icon name="queue" size={16} />
          <span>{label}</span>
          {idx === 0 && <span style={{ font: '400 11px "IBM Plex Mono"' }}>{action}</span>}
        </div>
      ))}
    </div>
  );
}

function PipelineRow({ label, count, sub, onClick, last }: { label: string; count: number; sub?: string; onClick: () => void; last?: boolean }) {
  return (
    <button
      className="wsg-camp"
      onClick={onClick}
      style={{ width: "100%", marginBottom: last ? 0 : 8 }}
    >
      <span className={`dot dot--${count > 0 ? "pass" : "queued"}`} />
      <span className="wsg-camp__name">{label}</span>
      {sub && (
        <span style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)", marginRight: 8 }}>{sub}</span>
      )}
      <span className="wsg-camp__size">{count}</span>
      <Icon name="chevron" size={12} color="var(--rt-fog-dim)" />
    </button>
  );
}

interface VerdictSummary {
  count: number;
  label: string;
  detail: string;
  kind: PillKind;
}

function summarizeVerdicts(artifacts: StudioArtifactEntry[]): VerdictSummary {
  const runCollection = artifacts.find((artifact) => artifact.id === "run-collection");
  const collectionCounts = compactCounts(runCollection?.totals_by_verdict);
  if (collectionCounts.length > 0) return verdictSummaryFromCounts(collectionCounts, "latest run collection");

  const counts = new Map<string, number>();
  for (const artifact of artifacts.filter((entry) => entry.kind === "run")) {
    const verdict = artifact.verdict ?? artifact.status;
    if (!verdict) continue;
    counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
  }
  const sorted = [...counts.entries()];
  if (sorted.length === 0) return { count: 0, label: "No verdicts", detail: "No verdict metadata yet", kind: "neutral" };
  return verdictSummaryFromCounts(sorted, "run artifacts");
}

function verdictSummaryFromCounts(counts: Array<[string, number]>, source: string): VerdictSummary {
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  const [dominant, dominantCount] = sorted[0]!;
  const total = sorted.reduce((sum, [, value]) => sum + value, 0);
  const scenarioLabel = total === 1 ? "scenario" : "scenarios";
  return {
    count: total,
    label: humanizeVerdict(dominant),
    kind: pillForVerdict(dominant),
    detail:
      sorted.length === 1
        ? `${dominantCount} ${scenarioLabel} in ${source}`
        : `${total} ${scenarioLabel} · ${sorted.map(([key, value]) => `${value} ${humanizeVerdict(key).toLowerCase()}`).join(" · ")}`
  };
}

function compactCounts(counts: Record<string, number> | undefined): Array<[string, number]> {
  if (!counts) return [];
  return Object.entries(counts).filter(([, value]) => value > 0);
}

function humanizeVerdict(value: string): string {
  const known: Record<string, string> = {
    "failure-observed": "Failure observed",
    "no-failure-observed": "No failure observed",
    "setup-error": "Setup error",
    inconclusive: "Inconclusive",
    interrupted: "Interrupted",
    pass: "Passed",
    passed: "Passed",
    fail: "Failed",
    failed: "Failed",
    error: "Errored",
    skipped: "Skipped"
  };
  return known[value] ?? value.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function pillForVerdict(value: string): PillKind {
  if (value === "failure-observed" || value === "fail" || value === "failed") return "fail";
  if (value === "no-failure-observed" || value === "pass" || value === "passed") return "pass";
  if (value === "setup-error" || value === "error") return "fail";
  if (value === "interrupted" || value === "inconclusive" || value === "skipped") return "neutral";
  return "neutral";
}

function pillForJob(status: Job["status"]): PillKind {
  if (status === "succeeded") return "pass";
  if (status === "failed") return "fail";
  if (status === "running") return "running";
  if (status === "queued") return "queued";
  return "neutral";
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "unknown";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}
