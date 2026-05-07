import { useEffect, useState } from "react";

import { api } from "../api";
import type { JobPlanPreview, StudioArtifactEntry } from "../studioTypes";
import { Icon } from "../ui/Icon";
import { EmptyState, Kicker, PageLabel, Pill, type PillKind } from "../ui/primitives";
import type { PageId } from "../shell/types";

interface CampaignsPageProps {
  workspaceId: string;
  onNavigate?: (id: PageId) => void;
}

export function CampaignsPage({ workspaceId, onNavigate }: CampaignsPageProps) {
  const [artifacts, setArtifacts] = useState<StudioArtifactEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<JobPlanPreview | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setArtifacts([]);
    setSelected(null);
    setSelectedRows(new Set());
    setPlan(null);
    setLaunching(false);
    api.artifacts(workspaceId)
      .then((res) => {
        if (cancelled) return;
        const campaigns = res.artifacts.filter((artifact) => artifact.kind === "campaign-input" || artifact.kind === "campaign-root");
        setArtifacts(campaigns);
        setSelected(campaigns[0]?.id ?? null);
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

  const inputs = artifacts.filter((artifact) => artifact.kind === "campaign-input");
  const roots = artifacts.filter((artifact) => artifact.kind === "campaign-root");
  const active = artifacts.find((artifact) => artifact.id === selected) ?? artifacts[0] ?? null;

  async function previewRun(target: StudioArtifactEntry | null) {
    if (!target) return;
    setPlan(null);
    setPlanError(null);
    if (target.kind !== "campaign-input") {
      setPlanError("Select a campaign input TOML to preview a campaign run.");
      return;
    }
    try {
      const res = await api.jobs.plan({ workspaceId, kind: "campaign-run", params: { campaign: target.relative_path } });
      setPlan(res.plan);
    } catch (err) {
      setPlanError((err as Error).message);
    }
  }

  async function runAll(target: StudioArtifactEntry | null) {
    if (!target || launching) return;
    setPlan(null);
    setPlanError(null);
    if (target.kind !== "campaign-input") {
      setPlanError("Select a campaign input TOML before running a campaign.");
      return;
    }
    setLaunching(true);
    try {
      await api.jobs.create({ workspaceId, kind: "campaign-run", params: { campaign: target.relative_path } });
      onNavigate?.("jobs");
    } catch (err) {
      setPlanError((err as Error).message);
    } finally {
      setLaunching(false);
    }
  }

  function toggleRow(id: string) {
    setSelectedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div>
      <PageLabel>CAMPAIGNS</PageLabel>
      {loading && <CampaignEmpty title="Loading campaigns" body="Fetching campaign inputs and campaign roots from .riptide." />}
      {error && <CampaignEmpty title="Studio API error" body={error} />}
      {!loading && !error && artifacts.length === 0 && (
        <CampaignEmpty
          title="No campaigns yet"
          body="No campaign TOML inputs or campaign run roots were found in this workspace."
          ctaLabel="Open Agent chat"
          onCta={() => onNavigate?.("handoff")}
        />
      )}
      {!loading && !error && artifacts.length > 0 && (
        <div className="lview" style={{ gridTemplateColumns: "340px 1fr" }}>
          <div className="lview__list">
            <div className="lview__list-head">
              <Kicker>CAMPAIGN INPUTS · {inputs.length}</Kicker>
              <Kicker>RUN HISTORY · {roots.length}</Kicker>
            </div>
            <div className="lview__list-body">
              {artifacts.map((artifact) => (
                <button
                  key={artifact.id}
                  className={`lview__row${active?.id === artifact.id ? " lview__row--active" : ""}`}
                  onClick={() => setSelected(artifact.id)}
                >
                  <div className="lview__row-top">
                    <Icon name="flame" size={13} color="var(--rt-fog-dim)" />
                    <span className="lview__row-name">{artifact.label}</span>
                    <Pill kind={artifact.kind === "campaign-input" ? "info" : pillForVerdict(artifact.verdict)}>
                      {artifact.kind === "campaign-input" ? "INPUT" : artifact.verdict ?? "ROOT"}
                    </Pill>
                  </div>
                  <div className="lview__row-meta">
                    <span style={{ fontFamily: "IBM Plex Mono" }}>{artifact.relative_path}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="lview__detail" style={{ padding: 0, display: "flex", flexDirection: "column" }}>
            {active && (
              <>
                <div style={{ padding: "18px 24px", borderBottom: "1px solid var(--rt-slate-line)" }}>
                  <Kicker style={{ marginBottom: 6 }}>{active.kind === "campaign-input" ? "CAMPAIGN INPUT" : "CAMPAIGN RUN ROOT"}</Kicker>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <h2 style={{ font: "600 22px Inter", margin: 0, color: "var(--rt-off-white)" }}>{active.label}</h2>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="btn btn--ghost btn--sm" onClick={() => previewRun(active)}>
                        <Icon name="play" size={13} />
                        Preview run
                      </button>
                      <button className="btn btn--primary btn--sm" onClick={() => runAll(active)} disabled={launching}>
                        <Icon name="play" size={13} />
                        {launching ? "Queueing..." : "Run all"}
                      </button>
                    </div>
                  </div>
                  <div style={{ font: '400 12px "IBM Plex Mono"', color: "var(--rt-fog-dim)", marginTop: 8 }}>
                    {active.relative_path} · updated {formatTime(active.updated_at)}
                  </div>
                </div>

                <div style={{ padding: 24 }}>
                  <div className="cm-axes" style={{ marginBottom: 18 }}>
                    <Axis label="Source" value={active.relative_path} />
                    <Axis label="Total runs" value={String(active.meta?.total_runs ?? "unknown")} />
                    <Axis label="Retained" value={String(active.meta?.retained_runs ?? "unknown")} />
                    <Axis label="Verdict" value={active.verdict ?? "not run"} />
                    <Axis label="Hash" value={active.canonical_hash ?? "none"} />
                  </div>

                  <Kicker style={{ marginBottom: 8 }}>SELECTED PREVIEW ROWS</Kicker>
                  <table className="cm-grid" style={{ marginBottom: 18 }}>
                    <thead>
                      <tr>
                        <th style={{ width: 36 }} />
                        <th>ARTIFACT</th>
                        <th>KIND</th>
                        <th>UPDATED</th>
                        <th>STATUS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[active, ...roots.filter((root) => root.id !== active.id).slice(0, 8)].map((row) => (
                        <tr key={row.id} className={selectedRows.has(row.id) ? "cm-row--sel" : ""}>
                          <td><input type="checkbox" checked={selectedRows.has(row.id)} onChange={() => toggleRow(row.id)} /></td>
                          <td style={{ color: "var(--rt-off-white)" }}>{row.label}</td>
                          <td>{row.kind}</td>
                          <td>{formatTime(row.updated_at)}</td>
                          <td><Pill kind={pillForVerdict(row.verdict ?? row.status)}>{row.verdict ?? row.status ?? "n/a"}</Pill></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  <div className="card" style={{ padding: 16 }}>
                    <Kicker style={{ marginBottom: 8 }}>JOB PLAN</Kicker>
                    {planError && <div style={{ color: "var(--rt-fail)", font: "400 13px Inter" }}>{planError}</div>}
                    {!plan && !planError && <div style={{ color: "var(--rt-fog-dim)", font: "400 13px Inter" }}>Click Preview run to ask the server for the allowlisted argv.</div>}
                    {plan && (
                      <>
                        <div className="code" style={{ marginBottom: 10 }}>{plan.command_string}</div>
                        <table className="ptable">
                          <tbody>
                            <tr><td>cwd</td><td>{plan.cwd}</td></tr>
                            <tr><td>expected artifact</td><td>{plan.expected_artifact ?? "n/a"}</td></tr>
                            <tr><td>notes</td><td>{plan.notes.join(" ") || "none"}</td></tr>
                          </tbody>
                        </table>
                      </>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CampaignEmpty({ title, body, ctaLabel, onCta }: { title: string; body: string; ctaLabel?: string; onCta?: () => void }) {
  return (
    <div className="card" style={{ padding: 0 }}>
      <EmptyState icon="flame" title={title} body={body} ctaLabel={ctaLabel} onCta={onCta} />
    </div>
  );
}

function Axis({ label, value }: { label: string; value: string }) {
  return (
    <div className="cm-axis">
      <span className="cm-axis__label">{label}</span>
      <span>{value}</span>
    </div>
  );
}

function pillForVerdict(value: string | undefined): PillKind {
  const normalized = (value ?? "").toLowerCase();
  if (normalized.includes("fail") || normalized.includes("error")) return "fail";
  if (normalized.includes("pass") || normalized.includes("no-failure")) return "pass";
  if (normalized.includes("run")) return "running";
  if (normalized.includes("warn") || normalized.includes("inconclusive")) return "warn";
  return "neutral";
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "unknown";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}
