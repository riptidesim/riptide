import { useState } from "react";

import { Icon } from "../ui/Icon";
import { LineChart, StackedBars } from "../ui/charts";
import { EmptyState, Kicker, PageLabel, Pill, type PillKind } from "../ui/primitives";

interface ArtifactItem {
  id: string;
  name: string;
  verdict?: string;
  vk?: PillKind;
  when: string;
}

interface ArtifactGroup {
  group: string;
  items: ArtifactItem[];
}

const ARTIFACTS: ArtifactGroup[] = [
  { group: "Run collections", items: [
    { id: "col_a", name: "sweep / 2026-05-06 / 14:30", verdict: "PASS", vk: "pass", when: "2h ago" },
    { id: "col_b", name: "oracle-divergence / 2026-05-06", verdict: "FAIL", vk: "fail", when: "12m ago" },
    { id: "col_c", name: "pre-mainnet readiness · v0.31", verdict: "WARN", vk: "warn", when: "yesterday" }
  ] },
  { group: "Runs", items: [
    { id: "r_b04ee", name: "rta_b04ee · lp-imbalance-walk", verdict: "PASS", vk: "pass", when: "21m" },
    { id: "r_2cb71", name: "rta_2cb71 · funding-cascade", verdict: "FAIL", vk: "fail", when: "38m" },
    { id: "r_77a13", name: "rta_77a13 · liquidation-sweep", verdict: "PASS", vk: "pass", when: "4h" }
  ] },
  { group: "Campaigns", items: [
    { id: "c_liq64", name: "liquidation × 64", verdict: "FAIL", vk: "fail", when: "5h" },
    { id: "c_orac32", name: "oracle-divergence × 32", verdict: "QUEUED", vk: "queued", when: "queued" }
  ] },
  { group: "Replay packs", items: [{ id: "p_2cb71", name: "replay_2cb71_t826.rta", when: "38m" }] },
  { group: "Readiness reports", items: [{ id: "rd_v031", name: "readiness · v0.31", verdict: "WARN", vk: "warn", when: "yesterday" }] },
  { group: "Markdown summaries", items: [{ id: "md_summary_w19", name: "weekly-summary · 2026-W19.md", when: "2d" }] }
];

function ReportSummary() {
  return (
    <div style={{ maxWidth: 720 }}>
      <h1 style={{ font: "600 22px Inter", color: "var(--rt-off-white)", margin: "0 0 6px" }}>
        funding-cascade · run rta_2cb71
      </h1>
      <div style={{ font: "400 14px/1.55 Inter", color: "var(--rt-fg-2)", marginBottom: 18 }}>
        Funding rate ran one-sided for 312 ticks; LP solvency held but funding bounds breached at tick 826. Evidence captured for replay.
      </div>

      <h3 style={{ font: "600 14px Inter", color: "var(--rt-off-white)", margin: "24px 0 8px" }}>Verdict</h3>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 18 }}>
        <Pill kind="fail">FAIL</Pill>
        <span style={{ font: "400 13px Inter", color: "var(--rt-fg-2)" }}>1 critical invariant fired · 1 high invariant fired</span>
      </div>

      <h3 style={{ font: "600 14px Inter", color: "var(--rt-off-white)", margin: "24px 0 8px" }}>Invariant fires</h3>
      <table className="ptable" style={{ marginBottom: 18 }}>
        <tbody>
          <tr><td>FundingRate in [-1%, +1%]</td><td>tick 826 · actual 1.34%</td></tr>
          <tr><td>OracleBounds within 25 bps</td><td>tick 712 · actual 31 bps</td></tr>
        </tbody>
      </table>

      <h3 style={{ font: "600 14px Inter", color: "var(--rt-off-white)", margin: "24px 0 8px" }}>Reproduce</h3>
      <div className="code" style={{ marginBottom: 12 }}>
        <span style={{ color: "var(--rt-teal)" }}>$</span> riptide replay rta_2cb71 --tick 826
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
        <button className="btn btn--primary btn--sm">
          <Icon name="play" size={12} />
          Replay at tick 826
        </button>
        <button className="btn btn--ghost btn--sm">
          <Icon name="branch" size={12} />
          Open in scenario editor
        </button>
        <button className="btn btn--ghost btn--sm">
          <Icon name="link" size={12} />
          Copy permalink
        </button>
      </div>
    </div>
  );
}

function ReportDashboard() {
  const fireData = Array.from({ length: 14 }, () => ({
    pass: Math.floor(Math.random() * 5),
    fail: Math.floor(Math.random() * 3)
  }));
  const solvency = Array.from({ length: 60 }, (_, i) => 1 + Math.sin(i / 9) * 0.05 + (Math.random() * 0.02 - 0.01));
  const funding = Array.from({ length: 60 }, (_, i) => 0.001 + (i > 48 ? (i - 48) * 0.0015 : Math.sin(i / 8) * 0.003));
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
      <div className="card" style={{ padding: 16 }}>
        <Kicker style={{ marginBottom: 6 }}>VERDICT</Kicker>
        <div style={{ font: '500 32px "IBM Plex Mono"', color: "var(--rt-amber)", lineHeight: 1, margin: "8px 0 6px" }}>FAIL</div>
        <div style={{ font: "400 12px Inter", color: "var(--rt-fog-dim)" }}>2 invariants fired · tick 712, 826</div>
      </div>
      <div className="card" style={{ padding: 16 }}>
        <Kicker style={{ marginBottom: 6 }}>RUNTIME</Kicker>
        <div style={{ font: '500 32px "IBM Plex Mono"', color: "var(--rt-off-white)", lineHeight: 1, margin: "8px 0 6px" }}>4m 22s</div>
        <div style={{ font: "400 12px Inter", color: "var(--rt-fog-dim)" }}>1000 ticks · 3.8 ticks/s</div>
      </div>
      <div className="card" style={{ padding: 16 }}>
        <Kicker style={{ marginBottom: 6 }}>EVENTS</Kicker>
        <div style={{ font: '500 32px "IBM Plex Mono"', color: "var(--rt-off-white)", lineHeight: 1, margin: "8px 0 6px" }}>1,200</div>
        <div style={{ font: "400 12px Inter", color: "var(--rt-fog-dim)" }}>actions · oracles · invariants</div>
      </div>
      <div className="card" style={{ padding: 18, gridColumn: "1 / -1" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <Kicker>INVARIANT FIRES · TIMELINE</Kicker>
          <span style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)" }}>1000 ticks · binned ×14</span>
        </div>
        <div style={{ height: 110 }}>
          <StackedBars data={fireData} />
        </div>
      </div>
      <div className="card" style={{ padding: 18, gridColumn: "1 / span 2" }}>
        <Kicker style={{ marginBottom: 6 }}>POOL SOLVENCY</Kicker>
        <div style={{ font: "500 13px Inter", color: "var(--rt-fg-2)", marginBottom: 8 }}>Reserves / shares · per tick</div>
        <div style={{ height: 130 }}>
          <LineChart data={solvency} />
        </div>
      </div>
      <div className="card" style={{ padding: 18 }}>
        <Kicker style={{ marginBottom: 6 }}>FUNDING RATE</Kicker>
        <div style={{ font: "500 13px Inter", color: "var(--rt-fg-2)", marginBottom: 8 }}>Bound: ±1.0%</div>
        <div style={{ height: 130 }}>
          <LineChart data={funding} />
        </div>
      </div>
      <div className="card" style={{ padding: 18, gridColumn: "1 / -1" }}>
        <Kicker style={{ marginBottom: 8 }}>PERSONA ACTION BREAKDOWN</Kicker>
        <table className="ptable" style={{ marginTop: 6 }}>
          <thead>
            <tr>
              <td style={{ color: "var(--rt-fog-dim)" }}>persona</td>
              <td style={{ color: "var(--rt-fog-dim)" }}>swap</td>
              <td style={{ color: "var(--rt-fog-dim)" }}>deposit</td>
              <td style={{ color: "var(--rt-fog-dim)" }}>redeem</td>
              <td style={{ color: "var(--rt-fog-dim)" }}>liquidate</td>
              <td style={{ color: "var(--rt-fog-dim)" }}>total</td>
            </tr>
          </thead>
          <tbody>
            <tr><td>retail-trader</td><td>184</td><td>22</td><td>14</td><td>0</td><td>220</td></tr>
            <tr><td>panic-retail</td><td>312</td><td>4</td><td>89</td><td>0</td><td>405</td></tr>
            <tr><td>arb-bot</td><td>561</td><td>0</td><td>0</td><td>0</td><td>561</td></tr>
            <tr><td>liquidator</td><td>0</td><td>0</td><td>0</td><td>14</td><td>14</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReportRaw() {
  const files = [
    "metadata.json",
    "verdict.json",
    "invariant-fires.json",
    "tick-trace.parquet",
    "event-log.jsonl",
    "persona-actions.parquet",
    "replay_2cb71_t826.rta",
    "README.md"
  ];
  const json = `{
  "run_id": "rta_2cb71",
  "scenario": "funding-cascade",
  "verdict": "FAIL",
  "engine":  "riptide-sim v0.3.1",
  "seed":    "0x9f3a2c66...c1b8",
  "ticks":   1000,
  "fired": [
    { "invariant": "FundingRate in [-1%, +1%]",
      "tick": 826, "actual": 0.0134, "bound": 0.01 },
    { "invariant": "OracleBounds within 25 bps",
      "tick": 712, "actual": 0.0031, "bound": 0.0025 }
  ],
  "result_hash": "7b3e1a7c9d6f...c1f4a5b6c8d9e0f1234"
}`;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "260px 1fr",
        gap: 0,
        height: "100%",
        minHeight: 360,
        border: "1px solid var(--rt-slate-line)",
        borderRadius: 8,
        overflow: "hidden"
      }}
    >
      <div style={{ borderRight: "1px solid var(--rt-slate-line)", padding: 8, overflowY: "auto" }}>
        {files.map((f, i) => (
          <div
            key={f}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 8px",
              cursor: "pointer",
              background: i === 1 ? "var(--rt-slate-2)" : "transparent",
              borderRadius: 4,
              marginBottom: 1
            }}
          >
            <Icon name="file" size={12} color="var(--rt-fog-dim)" />
            <span
              style={{
                font: '400 12px "IBM Plex Mono"',
                color: i === 1 ? "var(--rt-off-white)" : "var(--rt-fog)"
              }}
            >
              {f}
            </span>
          </div>
        ))}
      </div>
      <div style={{ padding: 16, overflowY: "auto" }}>
        <div className="code" style={{ background: "transparent", border: "none", padding: 0 }}>
          {json}
        </div>
      </div>
    </div>
  );
}

type ReportTab = "summary" | "dashboard" | "raw";

export function ReportsPage({ populated }: { populated: boolean }) {
  const [sel, setSel] = useState("r_2cb71");
  const [tab, setTab] = useState<ReportTab>("summary");

  if (!populated) {
    return (
      <div>
        <PageLabel>REPORTS</PageLabel>
        <div className="card" style={{ padding: 0 }}>
          <EmptyState
            icon="file"
            title="No reports yet"
            body="Reports are deterministic artifacts produced by your runs and campaigns. Once a scenario completes, evidence shows up here."
            ctaLabel="Run your first scenario"
          />
        </div>
      </div>
    );
  }

  const allItems = ARTIFACTS.flatMap((g) => g.items);
  const detail = allItems.find((i) => i.id === sel) ?? ARTIFACTS[1].items[1];

  return (
    <div>
      <PageLabel>REPORTS</PageLabel>
      <div className="lview" style={{ gridTemplateColumns: "320px 1fr" }}>
        <div className="lview__list">
          <div className="lview__list-head">
            <div className="search">
              <Icon name="search" size={13} color="var(--rt-fog-dim)" />
              <input placeholder="Search artifacts" />
            </div>
            <div className="chips">
              <button className="chip chip--active">all kinds</button>
              <button className="chip">verdict</button>
              <button className="chip">7d</button>
            </div>
            <button className="btn btn--ghost btn--sm" style={{ justifyContent: "center" }}>
              <Icon name="cpu" size={13} /> Compare two runs
            </button>
          </div>
          <div className="lview__list-body" style={{ padding: "4px 0" }}>
            {ARTIFACTS.map((g, gi) => (
              <div key={gi} style={{ marginBottom: 8 }}>
                <div style={{ padding: "10px 14px 4px", display: "flex", alignItems: "center", gap: 6 }}>
                  <Icon name="chevronDown" size={11} color="var(--rt-fog-dim)" />
                  <span
                    style={{
                      font: '500 10px "IBM Plex Mono"',
                      letterSpacing: ".16em",
                      textTransform: "uppercase",
                      color: "var(--rt-fog-dim)"
                    }}
                  >
                    {g.group}
                  </span>
                </div>
                {g.items.map((it) => (
                  <div
                    key={it.id}
                    className={`lview__row${sel === it.id ? " lview__row--active" : ""}`}
                    style={{ padding: "8px 14px 8px 28px", gap: 4, borderBottom: "none" }}
                    onClick={() => setSel(it.id)}
                  >
                    <div className="lview__row-top">
                      <Icon name="file" size={12} color="var(--rt-fog-dim)" />
                      <span className="lview__row-name" style={{ fontFamily: "IBM Plex Mono", fontSize: 12 }}>
                        {it.name}
                      </span>
                      {it.verdict && it.vk && <Pill kind={it.vk}>{it.verdict}</Pill>}
                    </div>
                    <div className="lview__row-meta" style={{ paddingLeft: 18 }}>
                      <span>{it.when}</span>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="lview__detail" style={{ padding: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "18px 28px 0", borderBottom: "1px solid var(--rt-slate-line)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
              <div>
                <Kicker style={{ marginBottom: 6 }}>RUN ARTIFACT</Kicker>
                <h2 style={{ font: '500 20px "IBM Plex Mono"', margin: 0, color: "var(--rt-off-white)" }}>
                  {detail.name}
                </h2>
                <div style={{ font: '400 12px "IBM Plex Mono"', color: "var(--rt-fog-dim)", marginTop: 6 }}>
                  seed 0x9f3a...c1b8 · engine riptide-sim v0.3.1 · 1000 ticks · {detail.when}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn--ghost btn--sm">
                  <Icon name="download" size={12} />
                  Download .rta
                </button>
                {detail.vk && detail.verdict && <Pill kind={detail.vk}>{detail.verdict}</Pill>}
              </div>
            </div>
            <div style={{ display: "flex", gap: 0, marginTop: 18 }}>
              {(
                [
                  ["summary", "Summary"],
                  ["dashboard", "Dashboard"],
                  ["raw", "Raw"]
                ] as const
              ).map(([k, l]) => (
                <button
                  key={k}
                  onClick={() => setTab(k)}
                  style={{
                    background: "transparent",
                    border: "none",
                    padding: "10px 14px",
                    font: "500 13px Inter",
                    cursor: "pointer",
                    color: tab === k ? "var(--rt-off-white)" : "var(--rt-fog-dim)",
                    borderBottom: tab === k ? "2px solid var(--rt-teal)" : "2px solid transparent"
                  }}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px" }}>
            {tab === "summary" && <ReportSummary />}
            {tab === "dashboard" && <ReportDashboard />}
            {tab === "raw" && <ReportRaw />}
          </div>
        </div>
      </div>
    </div>
  );
}
