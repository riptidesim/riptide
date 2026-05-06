import { useState } from "react";

import { Icon } from "../ui/Icon";
import { EmptyState, Kicker, PageLabel } from "../ui/primitives";
import type { PageId } from "../shell/types";

interface CampaignRun {
  name: string;
  status: string;
  dotKind: string;
  timeLabel: string;
  runId: string;
  progress: { done: number; total: number };
  mix: { pass: number; fail: number; inc: number; pending: number };
  population: { dominant: Record<string, number>; mixCount: number };
}

const ACTIVE_CAMPAIGN_RUNS: CampaignRun[] = [
  {
    name: "liquidation-cascade-sweep",
    status: "running", dotKind: "running",
    timeLabel: "Started 8m ago",
    runId: "crun_8f3c1",
    progress: { done: 47, total: 84 },
    mix: { pass: 39, fail: 5, inc: 3, pending: 37 },
    population: { dominant: { whale: 50, retail: 200, arb: 10 }, mixCount: 3 }
  },
  {
    name: "oracle-divergence-matrix",
    status: "running", dotKind: "running",
    timeLabel: "Started 22m ago",
    runId: "crun_a91d2",
    progress: { done: 28, total: 60 },
    mix: { pass: 18, fail: 8, inc: 2, pending: 32 },
    population: { dominant: { whale: 100, retail: 100, arb: 10 }, mixCount: 2 }
  },
  {
    name: "pre-mainnet-readiness",
    status: "finished", dotKind: "pass",
    timeLabel: "Finished 1h ago",
    runId: "crun_b04ee",
    progress: { done: 144, total: 144 },
    mix: { pass: 138, fail: 0, inc: 6, pending: 0 },
    population: { dominant: { whale: 50, retail: 200, arb: 10, liq: 5 }, mixCount: 4 }
  },
  {
    name: "funding-stress-week-19",
    status: "finished", dotKind: "fail",
    timeLabel: "Finished 4h ago",
    runId: "crun_2cb71",
    progress: { done: 64, total: 64 },
    mix: { pass: 38, fail: 22, inc: 4, pending: 0 },
    population: { dominant: { whale: 200, retail: 50, arb: 10 }, mixCount: 2 }
  }
];

const SHORT_KEYS: Record<string, string> = { whale: "w", retail: "r", arb: "a", liq: "l", panic: "p" };

function shortMix(counts: Record<string, number>) {
  return Object.entries(counts)
    .map(([k, n]) => `${n}${SHORT_KEYS[k] ?? k[0]}`)
    .join(" · ");
}

function ActiveCampaignRunsRow({ populated }: { populated: boolean }) {
  const runs = populated ? ACTIVE_CAMPAIGN_RUNS : [];
  return (
    <div style={{ marginBottom: 28 }}>
      <Kicker style={{ marginBottom: 12 }}>ACTIVE CAMPAIGN RUNS</Kicker>
      {runs.length === 0 ? (
        <div className="card" style={{ padding: "32px 20px", display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              style={{
                minHeight: 140,
                border: "1px dashed var(--rt-slate-line)",
                borderRadius: 10,
                display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column",
                gap: 8, padding: 16, color: "var(--rt-fog-dim)", fontSize: 12
              }}
            >
              <Icon name="flame" size={16} />
              <span>No active campaign run</span>
              {i === 0 && <button className="btn btn--ghost btn--sm" style={{ marginTop: 6 }}>Run a campaign</button>}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
          {runs.map((r, i) => {
            const pct = (r.progress.done / r.progress.total) * 100;
            return (
              <div key={i} className="simcard">
                <div className="simcard__top">
                  <span className={`dot dot--${r.dotKind}`} />
                  <span className="simcard__name">{r.name}</span>
                  <button className="side__icon-btn" title="Open">
                    <Icon name="external" size={13} />
                  </button>
                </div>
                <div className="simcard__time">{r.timeLabel}</div>
                <div className="simcard__divider" />
                <div className="simcard__meta-row">
                  <span className="simcard__runid">{r.runId}</span>
                  <span style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)" }}>
                    {r.progress.done} / {r.progress.total} sims
                  </span>
                </div>
                <div className="simcard__bar">
                  <div className="simcard__bar-fill" style={{ width: `${pct}%` }} />
                </div>
                <div style={{ font: '400 10.5px/1.4 "IBM Plex Mono"', color: "var(--rt-fog-dim)", marginTop: 8 }}>
                  <span style={{ letterSpacing: ".08em" }}>POPULATION</span> ·{" "}
                  <span style={{ color: "var(--rt-fg-2)" }}>{shortMix(r.population.dominant)}</span>{" "}
                  <span>(×{r.population.mixCount} mixes)</span>
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                  {r.mix.pass > 0 && <span className="cmix cmix--pass">{r.mix.pass} pass</span>}
                  {r.mix.fail > 0 && <span className="cmix cmix--fail">{r.mix.fail} fail</span>}
                  {r.mix.inc > 0 && <span className="cmix cmix--inc">{r.mix.inc} inc</span>}
                  {r.mix.pending > 0 && <span className="cmix cmix--pending">{r.mix.pending} pending</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface CampaignNode {
  id: string;
  name: string;
  size: string;
  dot: string;
  personas: Record<string, number>;
}

const CAMPAIGNS_GRAPH: CampaignNode[] = [
  { id: "c1", name: "liquidation-cascade-sweep", size: "3 × 4 × 7 = 84", dot: "running", personas: { whale: 50, retail: 200, arb: 10 } },
  { id: "c2", name: "oracle-divergence-matrix", size: "2 × 5 × 6 = 60", dot: "running", personas: { whale: 100, retail: 100, arb: 10 } },
  { id: "c3", name: "pre-mainnet-readiness", size: "4 × 6 × 6 = 144", dot: "pass", personas: { whale: 50, retail: 200, arb: 10, liq: 5 } },
  { id: "c4", name: "funding-stress-week-19", size: "2 × 4 × 8 = 64", dot: "fail", personas: { whale: 200, retail: 50, arb: 10 } },
  { id: "c5", name: "mev-sandwich-burst", size: "1 × 3 × 4 = 12", dot: "queued", personas: { whale: 30, arb: 50 } },
  { id: "c6", name: "redeem-spiral-walk", size: "2 × 3 × 6 = 36", dot: "pass", personas: { panic: 80, retail: 150 } }
];

const PERSONA_LABEL: Record<string, string> = {
  whale: "whale-deep",
  retail: "retail-trader",
  arb: "arb-bot",
  liq: "liquidator",
  panic: "panic-retail"
};

type Pane = "adapter" | "campaign" | "runs" | "reports";

interface WorkspaceGraphProps {
  populated: boolean;
  onNavigate: (id: PageId) => void;
}

function WorkspaceGraph({ populated, onNavigate }: WorkspaceGraphProps) {
  const [selCampaign, setSelCampaign] = useState("c1");
  const [pane, setPane] = useState<Pane>("campaign");
  const detail = CAMPAIGNS_GRAPH.find((c) => c.id === selCampaign)!;

  if (!populated) {
    return (
      <div className="card" style={{ padding: 0 }}>
        <div className="card__head">
          <div>
            <Kicker style={{ marginBottom: 4 }}>WORKSPACE</Kicker>
            <div className="card__title">Adapter → Campaigns → Runs → Reports</div>
            <div className="card__sub">No campaigns defined yet.</div>
          </div>
        </div>
        <div style={{ padding: 32, display: "flex", justifyContent: "center" }}>
          <EmptyState
            icon="flame"
            title="No campaigns yet"
            body="Configure a campaign from the Library or hand off to the agent."
            ctaLabel="+ Add campaign"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card__head" style={{ alignItems: "center" }}>
        <div>
          <Kicker style={{ marginBottom: 4 }}>WORKSPACE</Kicker>
          <div className="card__title">Adapter → Campaigns → Runs → Reports</div>
          <div className="card__sub">Click a campaign to inspect composition.</div>
        </div>
        <button className="btn btn--ghost btn--sm">
          <Icon name="plus" size={13} />
          Add
        </button>
      </div>
      <div className="card__body" style={{ paddingTop: 0 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "180px 1fr 360px",
            gap: 0,
            background: "var(--rt-ink)",
            border: "1px solid var(--rt-slate-line)",
            borderRadius: 8,
            minHeight: 380
          }}
        >
          {/* LEFT: pipeline columns */}
          <div style={{ padding: "18px 14px", borderRight: "1px solid var(--rt-slate-line)", display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="wsg-col-label">PIPELINE</div>
            <div className="wsg-node wsg-node--adapter wsg-node--nav" title="Open Adapter" onClick={() => onNavigate("adapter")}>
              <span className="dot dot--pass" />
              <div>
                <div className="wsg-node__name">Adapter</div>
                <div className="wsg-node__sub">lending.so · v0.31</div>
              </div>
            </div>
            <div className="wsg-arrow">↓</div>
            <div
              className={`wsg-node wsg-node--nav${pane === "campaign" ? " wsg-node--current" : ""}`}
              title="Inspect campaigns"
              onClick={() => setPane("campaign")}
            >
              <span className="dot dot--running" />
              <div>
                <div className="wsg-node__name">Campaigns</div>
                <div className="wsg-node__sub">{CAMPAIGNS_GRAPH.length} defined</div>
              </div>
            </div>
            <div className="wsg-arrow">↓</div>
            <div
              className={`wsg-node wsg-node--nav${pane === "runs" ? " wsg-node--current" : ""}`}
              title="Inspect runs"
              onClick={() => setPane("runs")}
            >
              <Icon name="play" size={11} color="var(--rt-fog-dim)" />
              <div>
                <div className="wsg-node__name">Runs</div>
                <div className="wsg-node__sub">184 total</div>
              </div>
            </div>
            <div className="wsg-arrow">↓</div>
            <div
              className={`wsg-node wsg-node--nav${pane === "reports" ? " wsg-node--current" : ""}`}
              title="Inspect reports"
              onClick={() => setPane("reports")}
            >
              <Icon name="file" size={11} color="var(--rt-fog-dim)" />
              <div>
                <div className="wsg-node__name">Reports</div>
                <div className="wsg-node__sub">6 unread</div>
              </div>
            </div>
          </div>

          {/* CENTER */}
          <div style={{ padding: 18, overflowY: "auto" }}>
            {pane === "campaign" && (
              <>
                <div className="wsg-col-label" style={{ marginBottom: 10 }}>{CAMPAIGNS_GRAPH.length} CAMPAIGNS</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {CAMPAIGNS_GRAPH.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => setSelCampaign(c.id)}
                      className={`wsg-camp${selCampaign === c.id ? " wsg-camp--active" : ""}`}
                    >
                      <span className={`dot dot--${c.dot}`} />
                      <span className="wsg-camp__name">{c.name}</span>
                      <span className="wsg-camp__size">{c.size}</span>
                      <Icon name="chevron" size={12} color="var(--rt-fog-dim)" />
                    </button>
                  ))}
                  <button className="wsg-camp wsg-camp--add">
                    <Icon name="plus" size={12} color="var(--rt-fog-dim)" />
                    <span style={{ color: "var(--rt-fog-dim)" }}>Add campaign…</span>
                  </button>
                </div>
              </>
            )}
            {pane === "adapter" && (
              <>
                <div className="wsg-col-label" style={{ marginBottom: 10 }}>ADAPTER · 1</div>
                <div className="wsg-camp wsg-camp--active" style={{ cursor: "default" }}>
                  <span className="dot dot--pass" />
                  <span className="wsg-camp__name">lending.so</span>
                  <span className="wsg-camp__size">v0.31</span>
                </div>
              </>
            )}
            {pane === "runs" && (
              <>
                <div className="wsg-col-label" style={{ marginBottom: 10 }}>RECENT RUNS · 6</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {[
                    { id: "crun_8f3c1", name: "liquidation-cascade-sweep", dot: "running", sub: "47 / 84" },
                    { id: "crun_a91d2", name: "oracle-divergence-matrix", dot: "running", sub: "28 / 60" },
                    { id: "crun_b04ee", name: "pre-mainnet-readiness", dot: "pass", sub: "144 / 144" },
                    { id: "crun_2cb71", name: "funding-stress-week-19", dot: "fail", sub: "64 / 64" },
                    { id: "crun_77a13", name: "lp-imbalance-grid", dot: "pass", sub: "45 / 45" }
                  ].map((r) => (
                    <div key={r.id} className="wsg-camp">
                      <span className={`dot dot--${r.dot}`} />
                      <span className="wsg-camp__name">{r.name}</span>
                      <span className="wsg-camp__size">{r.sub}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            {pane === "reports" && (
              <>
                <div className="wsg-col-label" style={{ marginBottom: 10 }}>REPORTS · 6 UNREAD</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {[
                    { id: "rta_2cb71", name: "funding-stress-week-19", dot: "fail" },
                    { id: "rta_b04ee", name: "pre-mainnet-readiness", dot: "pass" },
                    { id: "rta_77a13", name: "lp-imbalance-grid", dot: "pass" },
                    { id: "rta_a91d2", name: "oracle-divergence-matrix", dot: "running" }
                  ].map((r) => (
                    <div key={r.id} className="wsg-camp">
                      <span className={`dot dot--${r.dot}`} />
                      <span className="wsg-camp__name">{r.name}</span>
                      <span className="wsg-camp__size">{r.id}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* RIGHT */}
          <div style={{ padding: 18, borderLeft: "1px solid var(--rt-slate-line)", background: "var(--rt-slate-panel)" }}>
            {pane === "campaign" && (
              <>
                <Kicker style={{ marginBottom: 8 }}>CAMPAIGN COMPOSITION</Kicker>
                <div style={{ font: "500 16px Inter", color: "var(--rt-off-white)", marginBottom: 4 }}>{detail.name}</div>
                <div style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)", marginBottom: 14 }}>
                  matrix · {detail.size}
                </div>

                <div className="wsg-section-label">PERSONAS · {Object.keys(detail.personas).length}</div>
                <div className="wsg-chips">
                  {Object.entries(detail.personas).map(([k, n]) => (
                    <span key={k} className="wsg-chip">
                      <span style={{ color: "var(--rt-teal)", fontWeight: 600, marginRight: 4 }}>{n}×</span>
                      {PERSONA_LABEL[k] ?? k}
                    </span>
                  ))}
                </div>

                <div className="wsg-section-label">SCENARIOS · 4</div>
                <div className="wsg-chips">
                  <span className="wsg-chip">cascade-fast</span>
                  <span className="wsg-chip">cascade-slow</span>
                  <span className="wsg-chip">cascade-stuck-oracle</span>
                  <span className="wsg-chip">cascade-noisy</span>
                </div>

                <div className="wsg-section-label">INVARIANTS · 7</div>
                <div className="wsg-chips">
                  <span className="wsg-chip">CollateralHealth</span>
                  <span className="wsg-chip">LP_Solvency</span>
                  <span className="wsg-chip">+5 more</span>
                </div>

                <div className="wsg-section-label">PARAMETERS</div>
                <div style={{ font: '400 11.5px "IBM Plex Mono"', color: "var(--rt-fg-2)", marginBottom: 16, lineHeight: 1.6 }}>
                  ticks=1000 · seed∈{"{1,2,3}"}<br />
                  tps=2400 · trace=tick
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn btn--primary btn--sm" style={{ flex: 1, justifyContent: "center" }}>
                    <Icon name="play" size={12} />
                    Run all
                  </button>
                  <button className="btn btn--ghost btn--sm">
                    <Icon name="sparkles" size={12} />
                    Edit with agent
                  </button>
                </div>
              </>
            )}

            {pane === "adapter" && (
              <>
                <Kicker style={{ marginBottom: 8 }}>PROTOCOL ADAPTER</Kicker>
                <div style={{ font: "500 16px Inter", color: "var(--rt-off-white)", marginBottom: 4 }}>lending.so</div>
                <div style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)", marginBottom: 14 }}>cdylib · rust 1.76 · v0.31</div>
                <div className="wsg-section-label">ENTRYPOINTS · 6</div>
                <div className="wsg-chips">
                  {["deposit", "withdraw", "borrow", "repay", "liquidate", "flash_loan"].map((e) => (
                    <span key={e} className="wsg-chip">{e}</span>
                  ))}
                </div>
                <div className="wsg-section-label">ACCOUNTS</div>
                <div style={{ font: '400 11.5px "IBM Plex Mono"', color: "var(--rt-fg-2)", marginBottom: 16, lineHeight: 1.6 }}>
                  12 mapped · 2 PDAs<br />last test: pass · 218ms
                </div>
                <button className="btn btn--ghost btn--sm" style={{ width: "100%", justifyContent: "center" }} onClick={() => onNavigate("settings")}>
                  <Icon name="external" size={12} />
                  Open in Settings
                </button>
              </>
            )}

            {pane === "runs" && (
              <>
                <Kicker style={{ marginBottom: 8 }}>RUNS SUMMARY</Kicker>
                <div style={{ font: "500 16px Inter", color: "var(--rt-off-white)", marginBottom: 14 }}>184 total · 2 running · 4 queued</div>
                <div className="wsg-section-label">LAST 24 HOURS</div>
                <div style={{ font: '400 11.5px "IBM Plex Mono"', color: "var(--rt-fg-2)", marginBottom: 16, lineHeight: 1.6 }}>
                  pass: 142 · fail: 24<br />inc: 14 · running: 4
                </div>
                <div className="wsg-section-label">AVG RUNTIME</div>
                <div style={{ font: '500 24px "IBM Plex Mono"', color: "var(--rt-off-white)", marginBottom: 16 }}>4m 22s</div>
                <button className="btn btn--ghost btn--sm" style={{ width: "100%", justifyContent: "center" }} onClick={() => onNavigate("jobs")}>
                  <Icon name="external" size={12} />
                  Open Job queue
                </button>
              </>
            )}

            {pane === "reports" && (
              <>
                <Kicker style={{ marginBottom: 8 }}>REPORTS</Kicker>
                <div style={{ font: "500 16px Inter", color: "var(--rt-off-white)", marginBottom: 14 }}>6 unread · 184 total</div>
                <div className="wsg-section-label">VERDICT MIX · 7D</div>
                <div className="wsg-chips" style={{ marginBottom: 14 }}>
                  <span className="cmix cmix--pass">142 pass</span>
                  <span className="cmix cmix--fail">24 fail</span>
                  <span className="cmix cmix--inc">14 inc</span>
                </div>
                <div className="wsg-section-label">TOP INVARIANT FIRES</div>
                <div className="wsg-chips">
                  <span className="wsg-chip">FundingRate · 8</span>
                  <span className="wsg-chip">OracleBounds · 5</span>
                  <span className="wsg-chip">LP_Solvency · 2</span>
                </div>
                <button
                  className="btn btn--ghost btn--sm"
                  style={{ width: "100%", justifyContent: "center", marginTop: 16 }}
                  onClick={() => onNavigate("reports")}
                >
                  <Icon name="external" size={12} />
                  Open Reports
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface OverviewProps {
  populated: boolean;
  onNavigate: (id: PageId) => void;
}

export function OverviewPage({ populated, onNavigate }: OverviewProps) {
  return (
    <div>
      <PageLabel>DASHBOARD</PageLabel>
      <ActiveCampaignRunsRow populated={populated} />
      <WorkspaceGraph populated={populated} onNavigate={onNavigate} />
    </div>
  );
}
