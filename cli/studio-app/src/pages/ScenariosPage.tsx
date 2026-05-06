import { useState } from "react";

import { Icon } from "../ui/Icon";
import { EmptyState, Kicker, PageLabel, Pill, type PillKind } from "../ui/primitives";

interface Scenario {
  id: string;
  name: string;
  verdict: string;
  vk: PillKind;
  runs: number;
  updated: string;
  desc: string;
  personas: string[];
  invariants: number;
}

const SCENARIOS: Scenario[] = [
  { id: "lending-liquidation-sweep", name: "lending-liquidation-sweep", verdict: "PASS", vk: "pass", runs: 38, updated: "2h ago", desc: "Sweep liquidation cascades across collateral health levels.", personas: ["whale-deep", "liquidator", "retail-trader"], invariants: 6 },
  { id: "oracle-divergence-stress", name: "oracle-divergence-stress", verdict: "FAIL", vk: "fail", runs: 21, updated: "12m ago", desc: "Push oracle feeds apart and observe cascade.", personas: ["oracle-feed", "arb-bot"], invariants: 4 },
  { id: "lp-imbalance-walk", name: "lp-imbalance-walk", verdict: "PASS", vk: "pass", runs: 64, updated: "21m ago", desc: "Walk LP imbalance into the worst-case range.", personas: ["noisy-lp", "retail-trader"], invariants: 5 },
  { id: "funding-cascade", name: "funding-cascade", verdict: "FAIL", vk: "fail", runs: 12, updated: "38m ago", desc: "Funding rate runs away under one-sided positioning.", personas: ["retail-trader", "panic-retail"], invariants: 7 },
  { id: "flash-loan-attack", name: "flash-loan-attack", verdict: "INC", vk: "queued", runs: 4, updated: "1d ago", desc: "Flash-funded one-shot attack on collateral check.", personas: ["flash-attacker"], invariants: 3 },
  { id: "redeem-spiral", name: "redeem-spiral", verdict: "PASS", vk: "pass", runs: 18, updated: "2d ago", desc: "Redemption pressure under shrinking liquidity.", personas: ["frozen-lp", "panic-retail"], invariants: 5 },
  { id: "mev-sandwich-burst", name: "mev-sandwich-burst", verdict: "WARN", vk: "warn", runs: 9, updated: "3d ago", desc: "MEV searcher sandwiches a window of swaps.", personas: ["mev-sandwich", "retail-trader"], invariants: 2 },
  { id: "reward-keeper-stall", name: "reward-keeper-stall", verdict: "PASS", vk: "pass", runs: 18, updated: "1w ago", desc: "Keeper bot misses ticks; system must recover.", personas: ["keeper-bot"], invariants: 3 }
];

interface ScenariosPageProps {
  populated: boolean;
  embedded?: boolean;
}

export function ScenariosPage({ populated, embedded }: ScenariosPageProps) {
  const [sel, setSel] = useState("lending-liquidation-sweep");
  const detail = SCENARIOS.find((s) => s.id === sel)!;

  if (!populated) {
    return (
      <div>
        {!embedded && <PageLabel>SCENARIOS</PageLabel>}
        <div className="card" style={{ padding: 0 }}>
          <EmptyState
            icon="play"
            title="No scenarios authored"
            body="A scenario is a deterministic mix of personas, parameters, and a tick budget. Ask the agent to compose one against your adapter."
            ctaLabel="Ask agent to add a scenario"
          />
        </div>
      </div>
    );
  }

  const recentRuns: { id: string; when: string; verdict: string; vk: PillKind; tick: string }[] = [
    { id: "rta_8f3c1", when: "now", verdict: "RUNNING", vk: "running", tick: "612 / 1000" },
    { id: "rta_b04ee", when: "21m ago", verdict: "PASS", vk: "pass", tick: "1000 / 1000" },
    { id: "rta_2cb71", when: "38m ago", verdict: "FAIL", vk: "fail", tick: "826 / 1000" },
    { id: "rta_77a13", when: "4h ago", verdict: "PASS", vk: "pass", tick: "1000 / 1000" },
    { id: "rta_1c20e", when: "yesterday", verdict: "PASS", vk: "pass", tick: "1000 / 1000" }
  ];

  return (
    <div>
      {!embedded && <PageLabel>SCENARIOS</PageLabel>}
      <div className="lview">
        <div className="lview__list">
          <div className="lview__list-head">
            <div className="search">
              <Icon name="search" size={13} color="var(--rt-fog-dim)" />
              <input placeholder="Search scenarios" />
            </div>
            <button className="btn btn--ghost btn--sm" style={{ justifyContent: "center" }}>
              <Icon name="sparkles" size={13} /> Ask agent to add a scenario
            </button>
          </div>
          <div className="lview__list-body">
            {SCENARIOS.map((s) => (
              <div
                key={s.id}
                className={`lview__row${sel === s.id ? " lview__row--active" : ""}`}
                onClick={() => setSel(s.id)}
              >
                <div className="lview__row-top">
                  <span className="lview__row-name">{s.name}</span>
                  <Pill kind={s.vk}>{s.verdict}</Pill>
                </div>
                <div className="lview__row-meta">
                  <span style={{ fontFamily: "IBM Plex Mono" }}>{s.runs} runs</span>
                  <span>·</span>
                  <span>updated {s.updated}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="lview__detail">
          <Kicker style={{ marginBottom: 8 }}>SCENARIO</Kicker>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <h2 style={{ font: "600 22px Inter", margin: 0, letterSpacing: "-0.01em", color: "var(--rt-off-white)" }}>
              {detail.name}
            </h2>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn--ghost btn--sm">
                <Icon name="sparkles" size={13} />
                Edit with agent
              </button>
              <button className="btn btn--primary btn--sm">
                <Icon name="play" size={13} />
                Run now
              </button>
            </div>
          </div>
          <div style={{ font: "400 14px/1.55 Inter", color: "var(--rt-fg-2)", marginBottom: 18, maxWidth: 680 }}>
            {detail.desc}
          </div>

          <div style={{ font: '400 12px "IBM Plex Mono"', color: "var(--rt-fog-dim)", marginBottom: 18 }}>
            <Icon name="folder" size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
            .riptide/scenarios/{detail.id}.yaml
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
            <div>
              <Kicker style={{ marginBottom: 8 }}>PARAMETERS</Kicker>
              <table className="ptable">
                <tbody>
                  <tr><td>ticks</td><td>1000</td></tr>
                  <tr><td>seed</td><td>0x9f3a...c1b8</td></tr>
                  <tr><td>mode</td><td>campaign · 16 runs</td></tr>
                  <tr><td>tps</td><td>2400</td></tr>
                </tbody>
              </table>
            </div>
            <div>
              <Kicker style={{ marginBottom: 8 }}>PERSONAS</Kicker>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {detail.personas.map((p) => (
                  <div
                    key={p}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "7px 10px",
                      background: "var(--rt-slate-2)",
                      borderRadius: 6
                    }}
                  >
                    <Icon name="users" size={12} color="var(--rt-fog-dim)" />
                    <span style={{ font: '400 12px "IBM Plex Mono"', color: "var(--rt-off-white)" }}>{p}</span>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 14 }}>
                <Kicker style={{ marginBottom: 6 }}>INVARIANTS</Kicker>
                <div style={{ font: "400 13px Inter", color: "var(--rt-fg-2)" }}>{detail.invariants} attached</div>
              </div>
            </div>
          </div>

          <Kicker style={{ marginBottom: 8 }}>RECENT RUNS</Kicker>
          <div className="card" style={{ padding: 0 }}>
            <table className="ptable" style={{ width: "100%" }}>
              <tbody>
                {recentRuns.map((r) => (
                  <tr key={r.id} style={{ cursor: "pointer" }}>
                    <td style={{ fontFamily: "IBM Plex Mono", color: "var(--rt-off-white)" }}>{r.id}</td>
                    <td style={{ color: "var(--rt-fog)" }}>{r.when}</td>
                    <td style={{ color: "var(--rt-fog-dim)" }}>{r.tick}</td>
                    <td style={{ textAlign: "right" }}>
                      <Pill kind={r.vk}>{r.verdict}</Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
