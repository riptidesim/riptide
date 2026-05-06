import { useState } from "react";

import { Icon } from "../ui/Icon";
import { Kicker, PageLabel } from "../ui/primitives";

interface Step { id: number; label: string; done: boolean; next?: boolean }

const TUTORIAL_STEPS: Step[] = [
  { id: 1, label: "Pick an agent adapter", done: true },
  { id: 2, label: "Wire your protocol adapter", done: true },
  { id: 3, label: "Define your first persona", done: true },
  { id: 4, label: "Write a scenario", done: false, next: true },
  { id: 5, label: "Run your first scenario", done: false },
  { id: 6, label: "Read your first report", done: false },
  { id: 7, label: "Lock invariants for CI", done: false }
];

export function TutorialPage() {
  const [openIdx, setOpenIdx] = useState(0);
  const sections = [
    { title: "What is Riptide?", body: "Riptide is a deterministic economic simulation framework for Solana programs. You write scenarios and invariants; Riptide runs your real BPF bytecode against modeled actors and produces evidence — runs, replay packs, readiness reports." },
    { title: "How simulations work", body: "A run is a deterministic sequence of ticks. Each tick advances modeled actors; persona actions invoke your program; the engine records state. Same seed + same adapter = same hash. Always." },
    { title: "Adapter, personas, scenarios, invariants — explained", body: "Adapter wires your compiled program. Personas are actors that drive it. Scenarios bind personas + parameters. Invariants are falsifiable claims the engine watches." },
    { title: "Reading a report", body: "A report has Summary (markdown), Dashboard (charts), and Raw (artifact files). Lead with Summary; drill into Raw for replay packs." },
    { title: "Common workflows", body: "Author with the agent. Run locally. Lock invariants in CI. Replay specific tick ranges to debug. Compare runs for regressions." },
    { title: "Keyboard shortcuts", body: "g o — overview. g h — handoff. g r — reports. ⌘k — search. r — run scenario." }
  ];

  return (
    <div>
      <PageLabel>TUTORIAL</PageLabel>

      <div className="card" style={{ padding: 24, marginBottom: 16 }}>
        <Kicker style={{ marginBottom: 8 }}>GETTING STARTED</Kicker>
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 18 }}>
          <h2 style={{ font: "600 22px Inter", margin: 0, color: "var(--rt-off-white)", letterSpacing: "-0.01em" }}>
            Walk the framework, end to end.
          </h2>
          <span style={{ font: '400 12px "IBM Plex Mono"', color: "var(--rt-fog-dim)" }}>3 of 7 done</span>
        </div>
        <div style={{ height: 4, background: "var(--rt-slate-2)", borderRadius: 2, marginBottom: 24, overflow: "hidden" }}>
          <div style={{ height: "100%", width: "43%", background: "linear-gradient(90deg, var(--rt-teal), var(--rt-signal-cyan))" }} />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 0 }}>
          {TUTORIAL_STEPS.map((s, i) => (
            <button
              key={s.id}
              style={{
                padding: "14px 10px",
                background: s.next ? "var(--rt-slate-2)" : "transparent",
                border: "none",
                borderRight: i < 6 ? "1px solid var(--rt-slate-line)" : "none",
                cursor: "pointer",
                textAlign: "left",
                display: "flex",
                flexDirection: "column",
                gap: 8
              }}
            >
              <div
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 11,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: s.done ? "rgba(34,197,94,0.12)" : s.next ? "rgba(20,184,182,0.15)" : "var(--rt-slate-2)",
                  border: s.next ? "1px solid var(--rt-teal)" : "none",
                  color: s.done ? "var(--rt-pass)" : s.next ? "var(--rt-teal)" : "var(--rt-fog-dim)",
                  font: '500 11px "IBM Plex Mono"'
                }}
              >
                {s.done ? <Icon name="check" size={12} /> : s.id}
              </div>
              <div
                style={{
                  font: "500 12.5px Inter",
                  color: s.done ? "var(--rt-fog)" : s.next ? "var(--rt-off-white)" : "var(--rt-fog-dim)",
                  lineHeight: 1.35
                }}
              >
                {s.label}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="card" style={{ padding: 0, marginBottom: 16, overflow: "hidden" }}>
        <div
          style={{
            background: "linear-gradient(135deg, var(--rt-slate-panel), var(--rt-deep-ocean))",
            padding: 24,
            position: "relative",
            minHeight: 220
          }}
        >
          <div
            style={{
              position: "absolute",
              inset: 0,
              backgroundImage: "url(assets/hero-current.png)",
              backgroundSize: "cover",
              backgroundPosition: "right center",
              opacity: 0.35,
              pointerEvents: "none"
            }}
          />
          <div style={{ position: "relative", maxWidth: 520 }}>
            <Kicker style={{ marginBottom: 8 }}>WATCH · 4 MIN</Kicker>
            <h2 style={{ font: "600 24px Inter", color: "var(--rt-off-white)", margin: "0 0 8px", letterSpacing: "-0.01em" }}>
              From `riptide init` to a falsified invariant.
            </h2>
            <p style={{ font: "400 14px/1.6 Inter", color: "var(--rt-fg-2)", margin: "0 0 18px" }}>
              A four-minute walkthrough of the entire loop — wire the adapter, draft a persona, write a scenario, watch an invariant fire, replay the breaking tick.
            </p>
            <button className="btn btn--primary btn--sm">
              <Icon name="play" size={13} />
              Play tutorial
            </button>
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 0, marginBottom: 16 }}>
        {sections.map((s, i) => (
          <div key={i} style={{ borderBottom: i === sections.length - 1 ? "none" : "1px solid var(--rt-slate-line)" }}>
            <button
              onClick={() => setOpenIdx(openIdx === i ? -1 : i)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "16px 20px",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                textAlign: "left",
                font: "500 14px Inter",
                color: "var(--rt-off-white)"
              }}
            >
              <span style={{ font: '400 12px "IBM Plex Mono"', color: "var(--rt-fog-dim)", width: 24 }}>0{i + 1}</span>
              <span style={{ flex: 1 }}>{s.title}</span>
              <Icon
                name="chevronDown"
                size={14}
                color="var(--rt-fog-dim)"
                style={{ transform: openIdx === i ? "rotate(180deg)" : "" }}
              />
            </button>
            {openIdx === i && (
              <div style={{ padding: "0 20px 18px 56px", font: "400 14px/1.65 Inter", color: "var(--rt-fg-2)" }}>
                {s.body}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="card" style={{ padding: 18, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ font: "400 13px Inter", color: "var(--rt-fog-dim)" }}>Need more? Reach the team.</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn--ghost btn--sm">
            <Icon name="external" size={12} />
            docs.riptide.sh
          </button>
          <button className="btn btn--ghost btn--sm">
            <Icon name="external" size={12} />
            Discord
          </button>
          <button className="btn btn--ghost btn--sm">
            <Icon name="external" size={12} />
            GitHub
          </button>
        </div>
      </div>
    </div>
  );
}
