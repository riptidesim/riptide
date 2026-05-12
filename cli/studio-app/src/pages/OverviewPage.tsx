import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { api } from "../api";
import type { Job, StudioArtifactEntry } from "../studioTypes";
import { Donut, HorizontalBars, LineChart } from "../ui/charts";
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
  const [refreshing, setRefreshing] = useState(false);

  const fetchAll = useCallback(
    async (cancelled?: () => boolean) => {
      try {
        const [artifactRes, jobRes] = await Promise.all([
          api.artifacts(workspaceId),
          api.jobs.list(workspaceId)
        ]);
        if (cancelled?.()) return;
        setArtifacts(artifactRes.artifacts);
        setJobs(jobRes.jobs.filter((job) => job.workspace_id === workspaceId));
        setError(null);
      } catch (err) {
        if (!cancelled?.()) setError((err as Error).message);
      }
    },
    [workspaceId]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setArtifacts([]);
    setJobs([]);
    fetchAll(() => cancelled).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchAll]);

  const hasActiveJobs = jobs.some((job) => job.status === "queued" || job.status === "running");
  useEffect(() => {
    if (!hasActiveJobs) return;
    let cancelled = false;
    const id = window.setInterval(() => void fetchAll(() => cancelled), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [fetchAll, hasActiveJobs]);

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await fetchAll();
    } finally {
      setRefreshing(false);
    }
  }

  const runningJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");
  const campaignRoots = artifacts.filter((artifact) => artifact.kind === "campaign-root");
  const campaignInputs = artifacts.filter((artifact) => artifact.kind === "campaign-input");
  const runs = artifacts.filter((artifact) => artifact.kind === "run");
  const reports = artifacts.filter((artifact) =>
    ["run-collection", "last-run", "run", "campaign-root", "pack", "guided-sim", "readiness-report", "markdown-summary"].includes(artifact.kind)
  );
  const verdictMix = useMemo(() => summarizeVerdicts(artifacts), [artifacts]);
  const coverageBars = useMemo(() => summarizeCoverage(artifacts), [artifacts]);
  const invariantBars = useMemo(() => topInvariantPressure(artifacts), [artifacts]);
  const activitySeries = useMemo(() => activityByDay(artifacts, 14), [artifacts]);
  const activityLabels = useMemo(() => activityLabelsFor(14), []);
  const activityTotal = activitySeries.reduce((sum, n) => sum + n, 0);
  const jobStatusBars = useMemo(() => summarizeJobStatus(jobs), [jobs]);
  const jobStatusTotal = jobStatusBars.reduce((sum, row) => sum + row.value, 0);
  const activeJobsList = useMemo(
    () => jobs.filter((job) => job.status === "queued" || job.status === "running").slice(0, 3),
    [jobs]
  );

  const analyticsCards: Array<{ key: string; title: string; meta?: string; body: ReactNode }> = [
    {
      key: "verdict",
      title: "VERDICT BREAKDOWN",
      body: (
        <Donut
          pass={verdictMix.buckets.pass}
          fail={verdictMix.buckets.fail}
          inconclusive={verdictMix.buckets.inconclusive}
          legend={<VerdictLegend buckets={verdictMix.buckets} />}
        />
      )
    },
    {
      key: "activity",
      title: "ACTIVITY · 14 DAYS",
      meta: `${activityTotal} updates`,
      body: <div style={{ width: "100%" }}><LineChart data={activitySeries} labels={activityLabels} h={88} /></div>
    },
    {
      key: "coverage",
      title: "COVERAGE",
      body: <div style={{ width: "100%" }}><HorizontalBars data={coverageBars} labelWidth={88} /></div>
    }
  ];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <PageLabel>DASHBOARD</PageLabel>
        <button
          className="side__icon-btn"
          onClick={refresh}
          title="Refresh workspace"
          disabled={refreshing || loading}
          aria-label="Refresh workspace"
          style={{ marginBottom: 24 }}
        >
          <Icon name="refresh" size={13} />
        </button>
      </div>
      {loading && <InlineCard icon="refresh" title="Loading workspace" body="Fetching artifacts and jobs from the Studio API." />}
      {error && <InlineCard icon="plug" title="Studio API error" body={error} />}
      {!loading && !error && artifacts.length === 0 && jobs.length === 0 && (
        <div style={{ marginBottom: 24 }}>
          <InlineCard
            icon="plug"
            title="No workspace artifacts yet"
            body="Run a scenario or configure a campaign and these panels will populate from .riptide artifacts."
            ctaLabel="Configure with agent"
            onCta={() => onNavigate("handoff")}
          />
        </div>
      )}
      {!loading && !error && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginBottom: 18 }}>
            <MetricCard label="RUNS" value={String(runs.length)} sub={`${reports.length} report-capable artifacts`} />
            <MetricCard label="CAMPAIGNS" value={String(campaignInputs.length + campaignRoots.length)} sub={`${campaignRoots.length} completed roots`} />
            <MetricCard label="JOBS" value={String(runningJobs.length)} sub="queued or running now" />
            <VerdictMetricCard summary={verdictMix} />
          </div>

          {analyticsCards.length > 0 && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${analyticsCards.length}, minmax(0, 1fr))`,
                gap: 12,
                marginBottom: 18
              }}
            >
              {analyticsCards.map((card) => (
                <div key={card.key} className="card" style={{ padding: 16, display: "flex", flexDirection: "column" }}>
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
                    <Kicker>{card.title}</Kicker>
                    {card.meta && <span style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)" }}>{card.meta}</span>}
                  </div>
                  <div style={{ flex: 1, display: "flex", alignItems: "center" }}>{card.body}</div>
                </div>
              ))}
            </div>
          )}

          <div
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${1 + (invariantBars.length > 0 ? 1 : 0)}, minmax(0, 1fr))`,
              gap: 12,
              marginBottom: 18
            }}
          >
            <div className="card" style={{ padding: 16, display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
                <Kicker>JOB QUEUE</Kicker>
                <span style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)" }}>{jobStatusTotal} total</span>
              </div>
              <HorizontalBars data={jobStatusBars} labelWidth={88} />
              {activeJobsList.length > 0 && (
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--rt-slate-line)" }}>
                  <div style={{ font: '500 10px "IBM Plex Mono"', letterSpacing: "0.08em", color: "var(--rt-fog-dim)", marginBottom: 8 }}>
                    IN FLIGHT NOW
                  </div>
                  <div style={{ display: "grid", gap: 6 }}>
                    {activeJobsList.map((job) => (
                      <div
                        key={job.id}
                        style={{ display: "flex", alignItems: "center", gap: 8, font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)" }}
                      >
                        <span className={`dot dot--${job.status === "running" ? "running" : "queued"}`} />
                        <span style={{ color: "var(--rt-off-white)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {job.kind}
                        </span>
                        <Pill kind={pillForJob(job.status)} dot={job.status === "running"}>{job.status.toUpperCase()}</Pill>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            {invariantBars.length > 0 && (
              <div className="card" style={{ padding: 16 }}>
                <Kicker style={{ marginBottom: 12 }}>INVARIANT PRESSURE · TOP RUNS</Kicker>
                <HorizontalBars data={invariantBars} />
              </div>
            )}
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
                {runningJobs.slice(0, 4).map((job) => {
                  const argv = job.argv.join(" ");
                  return (
                  <div key={job.id} className="simcard">
                    <div className="simcard__top">
                      <span className={`dot dot--${job.status === "running" ? "running" : "queued"}`} />
                      <span className="simcard__name" title={argv}>{argv}</span>
                    </div>
                    <div className="simcard__time" title={job.id}>{job.id}</div>
                    <div className="simcard__divider" />
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <Pill kind={pillForJob(job.status)} dot={job.status === "running"}>{job.status.toUpperCase()}</Pill>
                      <span style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)" }}>{formatTime(job.updated_at)}</span>
                    </div>
                  </div>
                  );
                })}
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

function VerdictLegend({ buckets }: { buckets: VerdictBuckets }) {
  const rows: Array<{ label: string; value: number; color: string }> = [
    { label: "Pass", value: buckets.pass, color: "#22C55E" },
    { label: "Fail", value: buckets.fail, color: "#EF4444" },
    { label: "Inconclusive", value: buckets.inconclusive, color: "#7A8A99" }
  ];
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {rows.map((row) => (
        <div key={row.label} style={{ display: "flex", alignItems: "center", gap: 8, font: '400 12px "IBM Plex Mono"', color: "var(--rt-fog-dim)" }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: row.color, display: "inline-block" }} />
          <span style={{ color: "var(--rt-off-white)", minWidth: 28, textAlign: "right" }}>{row.value}</span>
          <span>{row.label}</span>
        </div>
      ))}
    </div>
  );
}

function InlineCard({
  icon,
  title,
  body,
  ctaLabel,
  onCta
}: {
  icon: "refresh" | "plug";
  title: string;
  body: string;
  ctaLabel?: string;
  onCta?: () => void;
}) {
  return (
    <div className="card" style={{ padding: 0 }}>
      <EmptyState icon={icon} title={title} body={body} ctaLabel={ctaLabel} onCta={onCta} />
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
          <Icon name="listTodo" size={16} />
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

interface VerdictBuckets {
  pass: number;
  fail: number;
  inconclusive: number;
}

interface VerdictSummary {
  count: number;
  label: string;
  detail: string;
  kind: PillKind;
  buckets: VerdictBuckets;
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
  if (sorted.length === 0) {
    return { count: 0, label: "No verdicts", detail: "No verdict metadata yet", kind: "neutral", buckets: { pass: 0, fail: 0, inconclusive: 0 } };
  }
  return verdictSummaryFromCounts(sorted, "run artifacts");
}

function bucketize(counts: Array<[string, number]>): VerdictBuckets {
  const buckets: VerdictBuckets = { pass: 0, fail: 0, inconclusive: 0 };
  for (const [key, value] of counts) {
    const kind = pillForVerdict(key);
    if (kind === "pass") buckets.pass += value;
    else if (kind === "fail") buckets.fail += value;
    else buckets.inconclusive += value;
  }
  return buckets;
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
    buckets: bucketize(counts),
    detail:
      sorted.length === 1
        ? `${dominantCount} ${scenarioLabel} in ${source}`
        : `${total} ${scenarioLabel} · ${sorted.map(([key, value]) => `${value} ${humanizeVerdict(key).toLowerCase()}`).join(" · ")}`
  };
}

function summarizeCoverage(artifacts: StudioArtifactEntry[]): { label: string; value: number; color: string }[] {
  const defaults = ["exercised", "partial", "unexercised"];
  const zeroed = defaults.map((key) => ({ label: humanizeCoverage(key), value: 0, color: colorForCoverage(key) }));

  const runCollection = artifacts.find((artifact) => artifact.id === "run-collection");
  let totals = runCollection?.totals_by_coverage;
  if (!totals || Object.keys(totals).length === 0) {
    const merged = new Map<string, number>();
    for (const artifact of artifacts) {
      for (const [key, value] of Object.entries(artifact.totals_by_coverage ?? {})) {
        merged.set(key, (merged.get(key) ?? 0) + value);
      }
    }
    if (merged.size === 0) return zeroed;
    totals = Object.fromEntries(merged);
  }
  const entries = Object.entries(totals);
  if (entries.length === 0) return zeroed;
  return entries
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => ({ label: humanizeCoverage(key), value, color: colorForCoverage(key) }));
}

function colorForCoverage(key: string): string {
  const k = key.toLowerCase();
  if (k === "exercised" || k.includes("high") || k.includes("full") || k.includes("complete")) return "#22C55E";
  if (k === "partial" || k.includes("partial") || k.includes("med")) return "#F59E0B";
  if (k === "unexercised" || k.includes("low") || k.includes("none") || k.includes("empty") || k.includes("missing")) return "#EF4444";
  return "#7A8A99";
}

function humanizeCoverage(key: string): string {
  return key.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function topInvariantPressure(artifacts: StudioArtifactEntry[]): { label: string; value: number; color: string }[] {
  return artifacts
    .filter((artifact) => artifact.kind === "run" && (artifact.invariant_fire_count ?? 0) > 0)
    .sort((a, b) => (b.invariant_fire_count ?? 0) - (a.invariant_fire_count ?? 0))
    .slice(0, 5)
    .map((artifact) => ({
      label: artifact.label,
      value: artifact.invariant_fire_count ?? 0,
      color: "#14B8B6"
    }));
}

function summarizeJobStatus(jobs: Job[]): { label: string; value: number; color: string }[] {
  const order: Array<{ status: Job["status"]; label: string; color: string }> = [
    { status: "running", label: "Running", color: "#14B8B6" },
    { status: "queued", label: "Queued", color: "#F59E0B" },
    { status: "succeeded", label: "Succeeded", color: "#22C55E" },
    { status: "failed", label: "Failed", color: "#EF4444" },
    { status: "cancelled", label: "Cancelled", color: "#7A8A99" }
  ];
  return order.map(({ status, label, color }) => ({
    label,
    value: jobs.filter((job) => job.status === status).length,
    color
  }));
}

function activityLabelsFor(days: number): string[] {
  const labels: string[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 1000 * 60 * 60 * 24);
    if (i === 0) labels.push("Today");
    else if (i === 1) labels.push("Yesterday");
    else labels.push(d.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  }
  return labels;
}

function activityByDay(artifacts: StudioArtifactEntry[], days: number): number[] {
  const now = Date.now();
  const dayMs = 1000 * 60 * 60 * 24;
  const buckets = new Array(days).fill(0);
  for (const artifact of artifacts) {
    if (!artifact.updated_at) continue;
    const t = Date.parse(artifact.updated_at);
    if (Number.isNaN(t)) continue;
    const diff = Math.floor((now - t) / dayMs);
    if (diff >= 0 && diff < days) {
      buckets[days - 1 - diff]++;
    }
  }
  return buckets;
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
