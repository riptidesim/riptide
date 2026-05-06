import { useEffect, useRef, useState } from "react";

import { Icon } from "../ui/Icon";
import { EmptyState, Kicker, PageLabel, Pill, type PillKind } from "../ui/primitives";

interface Campaign {
  id: string;
  name: string;
  size: string;
  total: number;
  verdict: string;
  vk: PillKind;
  when: string;
}

const CAMPAIGNS: Campaign[] = [
  { id: "c1", name: "liquidation-cascade-sweep", size: "3 mix × 4 scen × 7 seed", total: 84, verdict: "RUNNING", vk: "running", when: "8m ago" },
  { id: "c2", name: "oracle-divergence-matrix", size: "2 mix × 5 scen × 6 seed", total: 60, verdict: "RUNNING", vk: "running", when: "22m ago" },
  { id: "c3", name: "pre-mainnet-readiness", size: "4 mix × 6 scen × 6 seed", total: 144, verdict: "PASS", vk: "pass", when: "1h ago" },
  { id: "c4", name: "funding-stress-week-19", size: "2 mix × 4 scen × 8 seed", total: 64, verdict: "FAIL", vk: "fail", when: "4h ago" },
  { id: "c5", name: "mev-sandwich-burst", size: "1 mix × 3 scen × 4 seed", total: 12, verdict: "QUEUED", vk: "queued", when: "queued" },
  { id: "c6", name: "redeem-spiral-walk", size: "2 mix × 3 scen × 6 seed", total: 36, verdict: "PASS", vk: "pass", when: "yesterday" },
  { id: "c7", name: "lp-imbalance-grid", size: "3 mix × 3 scen × 5 seed", total: 45, verdict: "PASS", vk: "pass", when: "2d ago" }
];

interface PersonaLib { id: string; name: string }

const PERSONA_LIBRARY: PersonaLib[] = [
  { id: "whale", name: "whale-deep" },
  { id: "retail", name: "retail-trader" },
  { id: "arb", name: "arb-bot" },
  { id: "liq", name: "liquidator" },
  { id: "panic", name: "panic-retail" }
];

interface Mix { id: string; label: string; counts: Record<string, number> }

const POPULATION_MIXES: Mix[] = [
  { id: "mixA", label: "Mix A", counts: { whale: 50, retail: 200, arb: 10 } },
  { id: "mixB", label: "Mix B", counts: { whale: 100, retail: 100, arb: 10 } },
  { id: "mixC", label: "Mix C", counts: { whale: 200, retail: 50, arb: 10 } }
];

const SCENARIOS_AXIS = ["cascade-fast", "cascade-slow", "cascade-stuck-oracle", "cascade-noisy"];
const SEEDS_AXIS = [1, 2, 3, 4, 5, 6, 7];

interface MatrixRow {
  id: string;
  mixId: string;
  mixLabel: string;
  counts: Record<string, number>;
  scenario: string;
  seed: number;
  invariants: number;
  ticks: number;
  verdict: string;
  vk: PillKind;
}

function buildMatrix(): MatrixRow[] {
  const rows: MatrixRow[] = [];
  let i = 0;
  for (const m of POPULATION_MIXES) {
    for (const s of SCENARIOS_AXIS) {
      for (const seed of SEEDS_AXIS) {
        i++;
        const r = i / 84;
        const verdict =
          i < 35 ? (r < 0.5 ? "PASS" : r < 0.8 ? "FAIL" : "INC")
          : i < 47 ? "RUNNING"
          : "PENDING";
        const vkMap: Record<string, PillKind> = {
          PASS: "pass",
          FAIL: "fail",
          INC: "warn",
          RUNNING: "running",
          PENDING: "queued"
        };
        rows.push({
          id: `s_${i.toString().padStart(3, "0")}`,
          mixId: m.id,
          mixLabel: m.label,
          counts: m.counts,
          scenario: s,
          seed,
          invariants: 7,
          ticks: 1000,
          verdict,
          vk: vkMap[verdict]
        });
      }
    }
  }
  return rows;
}

const MATRIX = buildMatrix();

const PERSONA_SHORT: Record<string, string> = {
  whale: "whale",
  retail: "retail",
  arb: "arb",
  liq: "liq",
  panic: "panic"
};

interface PopulationCellChipsProps {
  counts: Record<string, number>;
  onClick: () => void;
}

function PopulationCellChips({ counts, onClick }: PopulationCellChipsProps) {
  const entries = Object.entries(counts);
  return (
    <button onClick={onClick} className="popcell">
      {entries.map(([pid, n]) => (
        <span key={pid} className="popchip">
          <span className="popchip__n">{n}</span>
          <span className="popchip__name">{PERSONA_SHORT[pid] ?? pid}</span>
        </span>
      ))}
    </button>
  );
}

interface PopulationPopoverProps {
  mix: Mix;
  onClose: () => void;
  onSave: (counts: Record<string, number>) => void;
}

function PopulationPopover({ mix, onClose, onSave }: PopulationPopoverProps) {
  const [counts, setCounts] = useState<Record<string, number>>(mix.counts);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  const total = Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0);
  return (
    <div className="popover-backdrop">
      <div ref={ref} className="popover" style={{ width: 320 }}>
        <div className="popover__head">
          <Kicker>EDIT POPULATION · {mix.label.toUpperCase()}</Kicker>
        </div>
        <div className="popover__body">
          {PERSONA_LIBRARY.map((p) => (
            <div key={p.id} className="popover__row">
              <span className="dot dot--pass" style={{ opacity: counts[p.id] ? 1 : 0.25 }} />
              <span style={{ flex: 1, font: "500 13px Inter", color: "var(--rt-off-white)" }}>{p.name}</span>
              <input
                type="number"
                min="0"
                value={counts[p.id] ?? 0}
                onChange={(e) =>
                  setCounts({ ...counts, [p.id]: Math.max(0, parseInt(e.target.value, 10) || 0) })
                }
                className="popover__num"
              />
            </div>
          ))}
        </div>
        <div className="popover__foot">
          <span style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)" }}>Total agents</span>
          <span style={{ font: '600 14px "IBM Plex Mono"', color: "var(--rt-off-white)" }}>{total}</span>
        </div>
        <div style={{ display: "flex", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--rt-slate-line)" }}>
          <button className="btn btn--ghost btn--sm" onClick={onClose} style={{ flex: 1, justifyContent: "center" }}>
            Cancel
          </button>
          <button
            className="btn btn--primary btn--sm"
            onClick={() => onSave(counts)}
            style={{ flex: 1, justifyContent: "center" }}
          >
            Save mix
          </button>
        </div>
      </div>
    </div>
  );
}

interface MixesPopoverProps {
  mixes: Mix[];
  onClose: () => void;
}

function MixesPopover({ mixes, onClose }: MixesPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);
  return (
    <div className="popover-backdrop">
      <div ref={ref} className="popover" style={{ width: 420 }}>
        <div className="popover__head">
          <Kicker>POPULATION MIXES · {mixes.length}</Kicker>
        </div>
        <div className="popover__body">
          {mixes.map((m) => (
            <div key={m.id} className="popover__row" style={{ alignItems: "flex-start", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
                <span style={{ font: '500 12px "IBM Plex Mono"', color: "var(--rt-teal)" }}>{m.label}</span>
                <span style={{ flex: 1 }} />
                <button className="btn btn--quiet btn--sm">
                  <Icon name="edit" size={11} />
                </button>
                <button className="btn btn--quiet btn--sm">
                  <Icon name="x" size={11} />
                </button>
              </div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {Object.entries(m.counts).map(([pid, n]) => (
                  <span key={pid} className="popchip">
                    <span className="popchip__n">{n}</span>
                    <span className="popchip__name">{PERSONA_SHORT[pid] ?? pid}</span>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--rt-slate-line)" }}>
          <button className="btn btn--ghost btn--sm" style={{ flex: 1, justifyContent: "center" }}>
            <Icon name="plus" size={11} />
            Add mix
          </button>
          <button className="btn btn--primary btn--sm" onClick={onClose} style={{ flex: 1, justifyContent: "center" }}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

export function CampaignsPage({ populated }: { populated: boolean }) {
  const [sel, setSel] = useState("c1");
  const [selRows, setSelRows] = useState<Set<string>>(new Set());
  const [editMix, setEditMix] = useState<Mix | null>(null);
  const [showMixes, setShowMixes] = useState(false);
  const [mixes, setMixes] = useState<Mix[]>(POPULATION_MIXES);
  const detail = CAMPAIGNS.find((c) => c.id === sel)!;

  if (!populated) {
    return (
      <div>
        <PageLabel>CAMPAIGNS</PageLabel>
        <div className="card" style={{ padding: 0 }}>
          <EmptyState
            icon="flame"
            title="No campaigns yet"
            body="A campaign is a matrix of simulations — personas × scenarios × seeds. Hand off to the agent or start blank."
            ctaLabel="+ New campaign"
          />
        </div>
      </div>
    );
  }

  const toggleRow = (id: string) => {
    setSelRows((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };
  const allSelected = selRows.size === MATRIX.length;
  const toggleAll = () => setSelRows(allSelected ? new Set() : new Set(MATRIX.map((r) => r.id)));

  return (
    <div>
      <PageLabel>CAMPAIGNS</PageLabel>
      <div className="lview" style={{ gridTemplateColumns: "340px 1fr" }}>
        <div className="lview__list">
          <div className="lview__list-head">
            <div className="search">
              <Icon name="search" size={13} color="var(--rt-fog-dim)" />
              <input placeholder="Search campaigns" />
            </div>
            <button className="btn btn--primary btn--sm" style={{ justifyContent: "center" }}>
              <Icon name="plus" size={13} /> New campaign
            </button>
          </div>
          <div className="lview__list-body">
            {CAMPAIGNS.map((c) => (
              <div
                key={c.id}
                className={`lview__row${sel === c.id ? " lview__row--active" : ""}`}
                onClick={() => setSel(c.id)}
              >
                <div className="lview__row-top">
                  <Icon name="flame" size={13} color="var(--rt-fog-dim)" />
                  <span className="lview__row-name">{c.name}</span>
                  <Pill kind={c.vk}>{c.verdict}</Pill>
                </div>
                <div className="lview__row-meta">
                  <span style={{ fontFamily: "IBM Plex Mono" }}>
                    {c.size} · {c.total} sims
                  </span>
                  <span>·</span>
                  <span>{c.when}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="lview__detail" style={{ padding: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "18px 24px", borderBottom: "1px solid var(--rt-slate-line)" }}>
            <Kicker style={{ marginBottom: 6 }}>CAMPAIGN</Kicker>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <h2 style={{ font: "600 22px Inter", margin: 0, color: "var(--rt-off-white)", letterSpacing: "-0.01em" }}>
                {detail.name}
              </h2>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn--ghost btn--sm">
                  <Icon name="sparkles" size={13} />
                  Edit with agent
                </button>
                <button className="btn btn--ghost btn--sm" disabled={selRows.size === 0}>
                  <Icon name="play" size={13} />
                  Run selected ({selRows.size})
                </button>
                <button className="btn btn--primary btn--sm">
                  <Icon name="play" size={13} />
                  Run all
                </button>
              </div>
            </div>
            <div style={{ font: '400 12px "IBM Plex Mono"', color: "var(--rt-fog-dim)" }}>
              matrix · {detail.size} = {detail.total} sims · last verdict {detail.verdict.toLowerCase()} · {detail.when}
            </div>
          </div>

          {/* Axes */}
          <div className="cm-axes">
            <div className="cm-axis cm-axis--accent" onClick={() => setShowMixes(true)}>
              <span className="cm-axis__label">Populations</span>
              <span>{mixes.length} mixes</span>
              <Icon name="chevronDown" size={11} color="var(--rt-fog-dim)" />
            </div>
            <div className="cm-axis">
              <span className="cm-axis__label">Scenarios</span>
              <span>{SCENARIOS_AXIS.length} variants</span>
              <Icon name="chevronDown" size={11} color="var(--rt-fog-dim)" />
            </div>
            <div className="cm-axis">
              <span className="cm-axis__label">Invariants</span>
              <span>7 attached</span>
              <Icon name="chevronDown" size={11} color="var(--rt-fog-dim)" />
            </div>
            <div className="cm-axis">
              <span className="cm-axis__label">Seeds</span>
              <span>1, 2, 3, 4, 5, 6, 7</span>
              <Icon name="chevronDown" size={11} color="var(--rt-fog-dim)" />
            </div>
            <div className="cm-axis">
              <span className="cm-axis__label">Ticks</span>
              <span>1000</span>
            </div>
          </div>

          {/* Matrix grid */}
          <div style={{ flex: 1, overflow: "auto" }}>
            <table className="cm-grid">
              <thead>
                <tr>
                  <th style={{ width: 32 }}>
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                  </th>
                  <th style={{ width: 80 }}>SIM</th>
                  <th style={{ width: 290 }}>POPULATION</th>
                  <th>SCENARIO</th>
                  <th style={{ width: 60 }}>SEED</th>
                  <th style={{ width: 80 }}>INV</th>
                  <th style={{ width: 80 }}>TICKS</th>
                  <th style={{ width: 100 }}>VERDICT</th>
                  <th style={{ width: 80 }}></th>
                </tr>
              </thead>
              <tbody>
                {MATRIX.slice(0, 60).map((r) => {
                  const mix = mixes.find((m) => m.id === r.mixId) ?? { id: r.mixId, label: r.mixLabel, counts: r.counts };
                  return (
                    <tr key={r.id} className={selRows.has(r.id) ? "cm-row--sel" : ""}>
                      <td>
                        <input type="checkbox" checked={selRows.has(r.id)} onChange={() => toggleRow(r.id)} />
                      </td>
                      <td style={{ color: "var(--rt-fog)" }}>{r.id}</td>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ font: '500 11px "IBM Plex Mono"', color: "var(--rt-teal)", minWidth: 38 }}>
                            {mix.label}
                          </span>
                          <PopulationCellChips counts={mix.counts} onClick={() => setEditMix(mix)} />
                        </div>
                      </td>
                      <td style={{ color: "var(--rt-off-white)" }}>{r.scenario}</td>
                      <td>{r.seed}</td>
                      <td>{r.invariants}</td>
                      <td>{r.ticks}</td>
                      <td>
                        <Pill kind={r.vk} dot={r.vk === "running"}>
                          {r.verdict}
                        </Pill>
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                          {r.vk === "pass" || r.vk === "fail" || r.vk === "warn" ? (
                            <>
                              <button className="btn btn--quiet btn--sm" title="Open report">
                                <Icon name="external" size={11} />
                              </button>
                              <button className="btn btn--quiet btn--sm" title="Replay">
                                <Icon name="play" size={11} />
                              </button>
                            </>
                          ) : r.vk === "queued" ? (
                            <button className="btn btn--quiet btn--sm">Run</button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ borderTop: "1px solid var(--rt-slate-line)", padding: "16px 24px", background: "var(--rt-slate-panel)" }}>
            <Kicker style={{ marginBottom: 8 }}>RECENT CAMPAIGN RUNS</Kicker>
            <table className="ptable" style={{ width: "100%" }}>
              <tbody>
                {[
                  { id: "crun_8f3c1", when: "8m ago", verdict: "RUNNING", vk: "running" as PillKind, prog: "47 / 84" },
                  { id: "crun_77a13", when: "4h ago", verdict: "PASS", vk: "pass" as PillKind, prog: "84 / 84" },
                  { id: "crun_2cb71", when: "yesterday", verdict: "FAIL", vk: "fail" as PillKind, prog: "62 / 84" }
                ].map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontFamily: "IBM Plex Mono", color: "var(--rt-off-white)" }}>{r.id}</td>
                    <td style={{ color: "var(--rt-fog-dim)" }}>{r.when}</td>
                    <td style={{ fontFamily: "IBM Plex Mono", color: "var(--rt-fog)" }}>{r.prog}</td>
                    <td>
                      <Pill kind={r.vk} dot={r.vk === "running"}>
                        {r.verdict}
                      </Pill>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <button className="btn btn--quiet btn--sm">
                        <Icon name="file" size={11} />
                        Open report
                      </button>
                      <button className="btn btn--quiet btn--sm" style={{ marginLeft: 4 }}>
                        <Icon name="play" size={11} />
                        Replay
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      {editMix && (
        <PopulationPopover
          mix={editMix}
          onClose={() => setEditMix(null)}
          onSave={(counts) => {
            setMixes(mixes.map((m) => (m.id === editMix.id ? { ...m, counts } : m)));
            setEditMix(null);
          }}
        />
      )}
      {showMixes && <MixesPopover mixes={mixes} onClose={() => setShowMixes(false)} />}
    </div>
  );
}
