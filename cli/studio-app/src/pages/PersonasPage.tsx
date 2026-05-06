import { useState } from "react";

import { Icon } from "../ui/Icon";
import { EmptyState, Kicker, PageLabel, Pill, type PillKind } from "../ui/primitives";

interface Persona {
  id: string;
  name: string;
  kind: string;
  desc: string;
  refs: number;
}

const PERSONAS: Persona[] = [
  { id: "whale-deep", name: "whale-deep", kind: "whale", desc: "Deep-pocketed LP that unwinds 40% of TVL over 600 ticks.", refs: 2 },
  { id: "whale-shallow", name: "whale-shallow", kind: "whale", desc: "Smaller whale providing initial liquidity, exits opportunistically.", refs: 1 },
  { id: "retail-trader", name: "retail-trader", kind: "retail", desc: "Small directional trades, follows trend with 60% conviction.", refs: 4 },
  { id: "panic-retail", name: "panic-retail", kind: "retail", desc: "Symmetric panic seller during drawdowns.", refs: 1 },
  { id: "arb-bot", name: "arb-bot", kind: "arbitrageur", desc: "Cross-venue arbitrage on price divergence > 25 bps.", refs: 3 },
  { id: "mev-sandwich", name: "mev-sandwich", kind: "arbitrageur", desc: "Searcher that sandwiches large swaps over a tick window.", refs: 1 },
  { id: "oracle-feed", name: "oracle-feed", kind: "oracle", desc: "Price feed actor with bounded jitter and stuck-feed mode.", refs: 2 },
  { id: "liquidator", name: "liquidator", kind: "liquidator", desc: "Health-factor monitor that fires partial liquidations.", refs: 2 },
  { id: "keeper-bot", name: "keeper-bot", kind: "keeper", desc: "Periodic system actor — reward distributor, sweep caller.", refs: 0 },
  { id: "flash-attacker", name: "flash-attacker", kind: "attacker", desc: "Flash-loan-funded one-shot attacker with custom payload.", refs: 0 },
  { id: "frozen-lp", name: "frozen-lp", kind: "lp", desc: "LP with no exits — soaks impermanent loss to test unwind paths.", refs: 1 },
  { id: "noisy-lp", name: "noisy-lp", kind: "lp", desc: "LP that adds/removes liquidity each 50 ticks.", refs: 1 }
];

const KIND_COLORS: Record<string, string> = {
  whale: "#22F0E6",
  retail: "#AEBDCB",
  arbitrageur: "#F5B041",
  oracle: "#7A8A99",
  liquidator: "#EF4444",
  keeper: "#14B8B6",
  attacker: "#EF4444",
  lp: "#22C55E"
};

interface PersonasPageProps {
  populated: boolean;
  embedded?: boolean;
}

export function PersonasPage({ populated, embedded }: PersonasPageProps) {
  const [sel, setSel] = useState("whale-deep");
  const [filter, setFilter] = useState("all");
  const list = PERSONAS.filter((p) => filter === "all" || p.kind === filter);
  const detail = PERSONAS.find((p) => p.id === sel)!;

  if (!populated) {
    return (
      <div>
        {!embedded && <PageLabel>PERSONAS</PageLabel>}
        <div className="card" style={{ padding: 0 }}>
          <EmptyState
            icon="users"
            title="No personas defined yet"
            body="Personas are the actors that drive your simulation — whales, retail, arbitrageurs, liquidators. Ask the agent to draft one from your protocol's user base."
            ctaLabel="Ask agent to add a persona"
          />
        </div>
      </div>
    );
  }

  const refs: { name: string; verdict: string; vk: PillKind }[] = [
    { name: "lending-liquidation-sweep", verdict: "PASS", vk: "pass" },
    { name: "oracle-divergence-stress", verdict: "FAIL", vk: "fail" }
  ];

  return (
    <div>
      {!embedded && <PageLabel>PERSONAS</PageLabel>}
      <div className="lview">
        <div className="lview__list">
          <div className="lview__list-head">
            <div className="search">
              <Icon name="search" size={13} color="var(--rt-fog-dim)" />
              <input placeholder="Search personas" />
            </div>
            <div className="chips">
              {["all", "whale", "retail", "arbitrageur", "liquidator", "oracle", "attacker"].map((f) => (
                <button key={f} className={`chip${filter === f ? " chip--active" : ""}`} onClick={() => setFilter(f)}>
                  {f}
                </button>
              ))}
            </div>
            <button className="btn btn--ghost btn--sm" style={{ justifyContent: "center" }}>
              <Icon name="sparkles" size={13} /> Ask agent to add a persona
            </button>
          </div>
          <div className="lview__list-body">
            {list.map((p) => (
              <div
                key={p.id}
                className={`lview__row${sel === p.id ? " lview__row--active" : ""}`}
                onClick={() => setSel(p.id)}
              >
                <div className="lview__row-top">
                  <span className="dot" style={{ background: KIND_COLORS[p.kind] }} />
                  <span className="lview__row-name">{p.name}</span>
                  {p.refs > 0 && <Pill kind="info">{p.refs} REF</Pill>}
                </div>
                <div className="lview__row-meta">
                  <span style={{ fontFamily: "IBM Plex Mono" }}>{p.kind}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="lview__detail">
          <Kicker style={{ marginBottom: 8 }}>{detail.kind.toUpperCase()}</Kicker>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <h2 style={{ font: "600 24px Inter", margin: 0, letterSpacing: "-0.01em", color: "var(--rt-off-white)" }}>
              {detail.name}
            </h2>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn--ghost btn--sm">
                <Icon name="external" size={13} />
                Open in editor
              </button>
              <button className="btn btn--primary btn--sm">
                <Icon name="sparkles" size={13} />
                Edit with agent
              </button>
            </div>
          </div>
          <div style={{ font: "400 14px/1.6 Inter", color: "var(--rt-fg-2)", marginBottom: 22, maxWidth: 640 }}>{detail.desc}</div>

          <div style={{ font: '400 12px "IBM Plex Mono"', color: "var(--rt-fog-dim)", marginBottom: 16 }}>
            <Icon name="folder" size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
            .riptide/personas/{detail.id}.yaml
          </div>

          <Kicker style={{ marginBottom: 8 }}>PARAMETERS</Kicker>
          <table className="ptable" style={{ marginBottom: 28 }}>
            <tbody>
              <tr><td>kind</td><td>{detail.kind}</td></tr>
              <tr><td>seed</td><td>0x9f3a2c66...c1b8</td></tr>
              <tr><td>capital</td><td>0.40 × pool.tvl</td></tr>
              <tr><td>schedule</td><td>linear unwind, 0..600 ticks</td></tr>
              <tr><td>slippage</td><td>tolerance: 35 bps</td></tr>
              <tr><td>actions</td><td>swap, withdraw, redeem</td></tr>
            </tbody>
          </table>

          <Kicker style={{ marginBottom: 8 }}>REFERENCED BY</Kicker>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {refs.slice(0, detail.refs).map((s, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 12px",
                  background: "var(--rt-slate-2)",
                  borderRadius: 6
                }}
              >
                <Icon name="play" size={13} color="var(--rt-fog-dim)" />
                <span style={{ flex: 1, font: "500 13px Inter", color: "var(--rt-off-white)" }}>{s.name}</span>
                <Pill kind={s.vk}>{s.verdict}</Pill>
                <Icon name="chevron" size={13} color="var(--rt-fog-dim)" />
              </div>
            ))}
            {detail.refs === 0 && (
              <div style={{ font: "400 13px Inter", color: "var(--rt-fog-dim)" }}>
                Not referenced by any scenario yet.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
