import { Fragment, useEffect, useMemo, useState } from "react";

import { api } from "../api";
import type { Job, JobStatus } from "../studioTypes";
import { Icon, type IconName } from "../ui/Icon";
import { EmptyState, Kicker, PageLabel, Pill, type PillKind } from "../ui/primitives";
import type { PageId } from "../shell/types";

interface JobsPageProps {
  workspaceId: string;
  onNavigate?: (id: PageId) => void;
}

type StatusTab = "all" | "running" | "queued" | "completed" | "failed";

export function JobsPage({ workspaceId, onNavigate }: JobsPageProps) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<StatusTab>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh(cancelled?: () => boolean) {
    try {
      const res = await api.jobs.list(workspaceId);
      if (cancelled?.()) return;
      const scoped = res.jobs.filter((job) => job.workspace_id === workspaceId);
      setJobs(scoped);
      setSelectedId((current) => current && scoped.some((job) => job.id === current) ? current : scoped[0]?.id ?? null);
      setError(null);
    } catch (err) {
      if (!cancelled?.()) setError((err as Error).message);
    } finally {
      if (!cancelled?.()) setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setJobs([]);
    setSelectedId(null);
    void refresh(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    if (!jobs.some((job) => job.status === "queued" || job.status === "running")) return;
    let cancelled = false;
    const id = window.setInterval(() => void refresh(() => cancelled), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [jobs, workspaceId]);

  const filtered = useMemo(() => jobs.filter((job) => matchesTab(job.status, tab)), [jobs, tab]);
  const detail = jobs.find((job) => job.id === selectedId) ?? filtered[0] ?? null;

  async function cancel(job: Job) {
    const res = await api.jobs.cancel(job.id);
    setJobs((current) => current.map((row) => row.id === job.id ? res.job : row));
  }

  return (
    <div>
      <PageLabel>JOB QUEUE</PageLabel>
      {loading && <JobsEmpty title="Loading jobs" body="Fetching persisted and in-memory jobs from the Studio queue." />}
      {error && <JobsEmpty title="Studio API error" body={error} />}
      {!loading && !error && jobs.length === 0 && (
        <JobsEmpty
          title="Idle"
          body="No jobs have been queued for this workspace yet. Start a run from Reports or Campaigns and it will appear here."
          ctaLabel="Open Reports"
          onCta={() => onNavigate?.("reports")}
        />
      )}
      {!loading && !error && jobs.length > 0 && (
        <div className="lview" style={{ gridTemplateColumns: "1.25fr 1fr" }}>
          <div className="lview__list">
            <div className="lview__list-head" style={{ gap: 8 }}>
              <div className="chips">
                {(["all", "running", "queued", "completed", "failed"] as const).map((next) => (
                  <button key={next} className={`chip${tab === next ? " chip--active" : ""}`} onClick={() => setTab(next)}>
                    {next}
                  </button>
                ))}
              </div>
            </div>
            <div className="lview__list-body">
              {filtered.map((job) => (
                <button
                  key={job.id}
                  className={`lview__row${detail?.id === job.id ? " lview__row--active" : ""}`}
                  onClick={() => setSelectedId(job.id)}
                >
                  <div className="lview__row-top">
                    <span className="side__item-icon">
                      <Icon name={iconForKind(job.kind)} size={14} color="var(--rt-fog-dim)" />
                    </span>
                    <span className="lview__row-name">{job.argv.join(" ")}</span>
                    <Pill kind={pillForStatus(job.status)} dot={job.status === "running"}>{job.status.toUpperCase()}</Pill>
                  </div>
                  <div className="lview__row-meta">
                    <span style={{ fontFamily: "IBM Plex Mono" }}>{job.id}</span>
                    <span>·</span>
                    <span>{formatTime(job.updated_at)}</span>
                    {job.exit_code !== null && (
                      <Fragment>
                        <span>·</span>
                        <span style={{ fontFamily: "IBM Plex Mono" }}>exit {job.exit_code}</span>
                      </Fragment>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>
          <div className="lview__detail" style={{ background: "var(--rt-ink)" }}>
            {detail && (
              <>
                <Kicker style={{ marginBottom: 6 }}>{detail.kind.toUpperCase()}</Kicker>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 6 }}>
                  <h2 style={{ font: "500 18px Inter", margin: 0, color: "var(--rt-off-white)" }}>{detail.argv.join(" ")}</h2>
                  <Pill kind={pillForStatus(detail.status)} dot={detail.status === "running"}>{detail.status.toUpperCase()}</Pill>
                </div>
                <div style={{ font: '400 12px "IBM Plex Mono"', color: "var(--rt-fog-dim)", marginBottom: 14 }}>
                  {detail.id} · {detail.cwd}
                </div>

                <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
                  {(detail.status === "running" || detail.status === "queued") && (
                    <button className="btn btn--ghost btn--sm" onClick={() => cancel(detail)}>
                      <Icon name="stop" size={12} />
                      Cancel
                    </button>
                  )}
                  {detail.expected_artifact && (
                    <button className="btn btn--ghost btn--sm" onClick={() => onNavigate?.("reports")}>
                      <Icon name="file" size={13} />
                      Open reports
                    </button>
                  )}
                </div>

                <Kicker style={{ marginBottom: 6 }}>ARGV</Kicker>
                <div className="code" style={{ marginBottom: 18 }}>{detail.argv.join(" ")}</div>

                <Kicker style={{ marginBottom: 6 }}>STDOUT TAIL</Kicker>
                <pre className="code" style={{ height: 180, overflowY: "auto", whiteSpace: "pre-wrap", marginBottom: 18 }}>
                  {detail.stdout_tail || "No stdout captured yet."}
                </pre>

                <Kicker style={{ marginBottom: 6 }}>STDERR TAIL</Kicker>
                <pre className="code" style={{ height: 140, overflowY: "auto", whiteSpace: "pre-wrap" }}>
                  {detail.stderr_tail || "No stderr captured yet."}
                </pre>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function JobsEmpty({ title, body, ctaLabel, onCta }: { title: string; body: string; ctaLabel?: string; onCta?: () => void }) {
  return (
    <div className="card" style={{ padding: 0 }}>
      <EmptyState icon="queue" title={title} body={body} ctaLabel={ctaLabel} onCta={onCta} />
    </div>
  );
}

function matchesTab(status: JobStatus, tab: StatusTab): boolean {
  if (tab === "all") return true;
  if (tab === "running") return status === "running";
  if (tab === "queued") return status === "queued";
  if (tab === "completed") return status === "succeeded" || status === "cancelled";
  return status === "failed";
}

function iconForKind(kind: Job["kind"]): IconName {
  if (kind.startsWith("campaign")) return "flame";
  if (kind === "review") return "file";
  if (kind === "readiness") return "check";
  if (kind === "replay") return "refresh";
  return "play";
}

function pillForStatus(status: JobStatus): PillKind {
  if (status === "succeeded") return "pass";
  if (status === "failed") return "fail";
  if (status === "running") return "running";
  if (status === "queued") return "queued";
  return "neutral";
}

function formatTime(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}
