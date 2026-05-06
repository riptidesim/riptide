import { useState } from "react";

import { Icon } from "../ui/Icon";
import { EmptyState, Kicker, PageLabel, Pill, type PillKind } from "../ui/primitives";

interface Invariant {
  id: string;
  name: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "INFO";
  fires: number;
  desc: string;
  code?: string;
}

const INVARIANTS: Invariant[] = [
  {
    id: "collateral-health",
    name: "CollateralHealth >= 1.0",
    severity: "CRITICAL",
    fires: 12,
    desc: "Every borrower position must keep its health factor above 1.0 at every tick.",
    code: "invariant CollateralHealth:\n  forall position p:\n    p.collateral_value / p.debt_value >= 1.0"
  },
  {
    id: "lp-solvency",
    name: "LP_Solvency >= 1.0",
    severity: "CRITICAL",
    fires: 4,
    desc: "Pool reserves must cover all outstanding LP shares at fair price.",
    code: "invariant LP_Solvency:\n  pool.reserves >= pool.shares * pool.fair_price"
  },
  {
    id: "oracle-bounds",
    name: "OracleBounds within 25 bps",
    severity: "HIGH",
    fires: 8,
    desc: "Oracle price cannot drift more than 25 bps from TWAP within a tick window.",
    code: "invariant OracleBounds(window=10):\n  |oracle.price - twap(window)| / twap(window) <= 0.0025"
  },
  { id: "funding-bounds", name: "FundingRate in [-1%, +1%]", severity: "HIGH", fires: 1, desc: "Funding rate per epoch must stay within ±1%." },
  { id: "no-double-redeem", name: "NoDoubleRedeem", severity: "CRITICAL", fires: 0, desc: "A position cannot be redeemed twice within the same tick." },
  { id: "reward-monotone", name: "RewardAccrualMonotone", severity: "MEDIUM", fires: 14, desc: "Cumulative rewards per share must never decrease." },
  { id: "min-liquidation", name: "MinLiquidationSize >= 100 USD", severity: "MEDIUM", fires: 6, desc: "Each liquidation must be at least $100 to avoid dust attacks." },
  { id: "tick-monotone", name: "TickMonotone", severity: "INFO", fires: 0, desc: "Block ticks must increase monotonically." }
];

const SEVERITY_KIND: Record<Invariant["severity"], PillKind> = {
  CRITICAL: "fail",
  HIGH: "warn",
  MEDIUM: "info",
  INFO: "neutral"
};

interface InvariantsPageProps {
  populated: boolean;
  embedded?: boolean;
}

export function InvariantsPage({ populated, embedded }: InvariantsPageProps) {
  const [sel, setSel] = useState("collateral-health");
  const [filter, setFilter] = useState("all");
  const list = INVARIANTS.filter((i) => filter === "all" || i.severity.toLowerCase() === filter);
  const detail = INVARIANTS.find((i) => i.id === sel)!;

  if (!populated) {
    return (
      <div>
        {!embedded && <PageLabel>INVARIANTS</PageLabel>}
        <div className="card" style={{ padding: 0 }}>
          <EmptyState
            icon="shield"
            title="No invariants attached"
            body="Invariants are the falsifiable claims your simulation tries to break. Ask the agent to draft them from your protocol's risk model."
            ctaLabel="Ask agent to add an invariant"
          />
        </div>
      </div>
    );
  }

  const fires = [
    { id: "rta_2cb71", scen: "funding-cascade", tick: "826", when: "38m ago" },
    { id: "rta_a91d2", scen: "oracle-divergence-stress", tick: "248", when: "12m ago" },
    { id: "rta_b8e02", scen: "flash-loan-attack", tick: "15", when: "1d ago" },
    { id: "rta_19f3c", scen: "lending-liquidation-sweep", tick: "612", when: "2h ago" }
  ];

  return (
    <div>
      {!embedded && <PageLabel>INVARIANTS</PageLabel>}
      <div className="lview">
        <div className="lview__list">
          <div className="lview__list-head">
            <div className="search">
              <Icon name="search" size={13} color="var(--rt-fog-dim)" />
              <input placeholder="Search invariants" />
            </div>
            <div className="chips">
              {["all", "critical", "high", "medium", "info"].map((f) => (
                <button key={f} className={`chip${filter === f ? " chip--active" : ""}`} onClick={() => setFilter(f)}>
                  {f}
                </button>
              ))}
            </div>
            <button className="btn btn--ghost btn--sm" style={{ justifyContent: "center" }}>
              <Icon name="sparkles" size={13} /> Ask agent to add an invariant
            </button>
          </div>
          <div className="lview__list-body">
            {list.map((inv) => (
              <div
                key={inv.id}
                className={`lview__row${sel === inv.id ? " lview__row--active" : ""}`}
                onClick={() => setSel(inv.id)}
              >
                <div className="lview__row-top">
                  <span className="lview__row-name" style={{ fontFamily: "IBM Plex Mono", fontSize: 12.5 }}>
                    {inv.name}
                  </span>
                </div>
                <div className="lview__row-meta">
                  <Pill kind={SEVERITY_KIND[inv.severity]}>{inv.severity}</Pill>
                  <span style={{ marginLeft: "auto", fontFamily: "IBM Plex Mono" }}>
                    <Icon
                      name="flame"
                      size={11}
                      style={{ verticalAlign: "-2px", marginRight: 3 }}
                      color={inv.fires > 0 ? "var(--rt-fail)" : "var(--rt-fog-dim)"}
                    />
                    {inv.fires} fires
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="lview__detail">
          <Kicker style={{ marginBottom: 8 }}>INVARIANT · {detail.severity}</Kicker>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 14 }}>
            <h2 style={{ font: '500 22px "IBM Plex Mono"', margin: 0, letterSpacing: "-0.005em", color: "var(--rt-off-white)" }}>
              {detail.name}
            </h2>
            <button className="btn btn--primary btn--sm">
              <Icon name="sparkles" size={13} />
              Edit with agent
            </button>
          </div>
          <div style={{ font: "400 14px/1.55 Inter", color: "var(--rt-fg-2)", marginBottom: 18, maxWidth: 680 }}>
            {detail.desc}
          </div>

          <div style={{ font: '400 12px "IBM Plex Mono"', color: "var(--rt-fog-dim)", marginBottom: 18 }}>
            <Icon name="folder" size={12} style={{ verticalAlign: "-2px", marginRight: 4 }} />
            .riptide/invariants/{detail.id}.rule
          </div>

          {detail.code && (
            <>
              <Kicker style={{ marginBottom: 8 }}>PREDICATE</Kicker>
              <div className="code" style={{ marginBottom: 24 }}>
                {detail.code}
              </div>
            </>
          )}

          <Kicker style={{ marginBottom: 8 }}>FIRES BY RUN</Kicker>
          <div className="card" style={{ padding: 0 }}>
            <table className="ptable" style={{ width: "100%" }}>
              <tbody>
                {fires.slice(0, Math.min(detail.fires, 4)).map((f) => (
                  <tr key={f.id} style={{ cursor: "pointer" }}>
                    <td style={{ fontFamily: "IBM Plex Mono", color: "var(--rt-off-white)" }}>{f.id}</td>
                    <td style={{ color: "var(--rt-fog)" }}>{f.scen}</td>
                    <td style={{ fontFamily: "IBM Plex Mono", color: "var(--rt-fail)" }}>tick {f.tick}</td>
                    <td style={{ color: "var(--rt-fog-dim)", textAlign: "right" }}>{f.when}</td>
                  </tr>
                ))}
                {detail.fires === 0 && (
                  <tr>
                    <td colSpan={4} style={{ textAlign: "center", color: "var(--rt-fog-dim)", padding: 18 }}>
                      This invariant has not fired in any run.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
