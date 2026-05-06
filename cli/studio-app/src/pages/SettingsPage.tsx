import { useState } from "react";

import { Icon } from "../ui/Icon";
import { Kicker, PageLabel, Pill } from "../ui/primitives";
import { TabStrip } from "../ui/TabStrip";

type SettingsTab = "adapters" | "workspace" | "about";

export function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>("adapters");

  const adapters = [
    { name: "Claude Code", detail: "/usr/local/bin/claude · v0.18.2", dot: "pass", active: true },
    { name: "Codex", detail: "/usr/local/bin/codex · v1.4.0", dot: "pass", active: false },
    { name: "Gemini CLI", detail: "/usr/local/bin/gemini · v0.9.1", dot: "queued", active: false },
    { name: "Cursor", detail: "CLI not on PATH", dot: "fail", active: false },
    { name: "OpenCode", detail: "CLI not on PATH", dot: "fail", active: false }
  ];

  return (
    <div>
      <PageLabel>SETTINGS</PageLabel>
      <TabStrip
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "adapters", label: "Adapters" },
          { id: "workspace", label: "Workspace" },
          { id: "about", label: "About" }
        ]}
      />
      {tab === "adapters" && (
        <div className="card" style={{ padding: 24, maxWidth: 880 }}>
          <Kicker style={{ marginBottom: 8 }}>CODING AGENTS</Kicker>
          <div style={{ font: "500 16px Inter", color: "var(--rt-off-white)", marginBottom: 4 }}>Adapter CLI selection</div>
          <div style={{ font: "400 13px Inter", color: "var(--rt-fg-2)", marginBottom: 14 }}>
            Studio sends authoring tasks to a locally-installed coding agent.
          </div>
          {adapters.map((a, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 14px",
                background: "var(--rt-slate-2)",
                borderRadius: 6,
                marginBottom: 6,
                border: a.active ? "1px solid var(--rt-teal)" : "1px solid transparent"
              }}
            >
              <span className={`dot dot--${a.dot}`} />
              <div style={{ flex: 1 }}>
                <div style={{ font: "500 13px Inter", color: "var(--rt-off-white)" }}>{a.name}</div>
                <div style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)", marginTop: 2 }}>
                  {a.detail}
                </div>
              </div>
              {a.active && <Pill kind="info">ACTIVE</Pill>}
              {!a.active && a.dot !== "fail" && <button className="btn btn--ghost btn--sm">Use</button>}
            </div>
          ))}
          <div
            style={{
              marginTop: 18,
              padding: 14,
              background: "var(--rt-slate-2)",
              border: "1px solid var(--rt-slate-line)",
              borderRadius: 6
            }}
          >
            <div style={{ font: '500 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)", letterSpacing: "0.08em", marginBottom: 6 }}>
              PROBE
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ flex: 1, font: "400 12px Inter", color: "var(--rt-fg-2)" }}>
                Test the active CLI's availability and response.
              </span>
              <button className="btn btn--ghost btn--sm">
                <Icon name="cpu" size={12} />
                Test now
              </button>
            </div>
          </div>
        </div>
      )}
      {tab === "workspace" && (
        <div className="card" style={{ padding: 24, maxWidth: 880 }}>
          <Kicker style={{ marginBottom: 8 }}>WORKSPACE</Kicker>
          <div style={{ font: "500 16px Inter", color: "var(--rt-off-white)", marginBottom: 4 }}>Paths & defaults</div>
          <div style={{ font: "400 13px Inter", color: "var(--rt-fg-2)", marginBottom: 14 }}>
            Workspace location, simulation seeds, and autorun preferences.
          </div>
          <table className="ptable" style={{ marginBottom: 18 }}>
            <tbody>
              <tr><td>name</td><td>lending-fund</td></tr>
              <tr><td>path</td><td>~/code/lending-fund/.riptide</td></tr>
              <tr><td>created</td><td>2025-11-12</td></tr>
              <tr><td>git remote</td><td>origin git@github.com:tide/lending-fund</td></tr>
            </tbody>
          </table>
          <Kicker style={{ marginBottom: 8 }}>DEFAULTS</Kicker>
          <table className="ptable">
            <tbody>
              <tr><td>default seed</td><td>0xdeadbeef</td></tr>
              <tr><td>autorun on save</td><td>off</td></tr>
              <tr><td>parallel jobs</td><td>4</td></tr>
              <tr><td>retain runs</td><td>last 50</td></tr>
            </tbody>
          </table>
        </div>
      )}
      {tab === "about" && (
        <div className="card" style={{ padding: 24, maxWidth: 600 }}>
          <Kicker style={{ marginBottom: 10 }}>ABOUT</Kicker>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
            <img src="assets/logo-icon.png" style={{ width: 36, height: 36 }} />
            <div>
              <div style={{ font: "600 18px Inter", color: "var(--rt-off-white)" }}>Riptide Studio</div>
              <div style={{ font: '400 12px "IBM Plex Mono"', color: "var(--rt-fog-dim)" }}>
                v0.31 · engine riptide-sim 0.3.1
              </div>
            </div>
          </div>
          <div style={{ font: "400 13px/1.6 Inter", color: "var(--rt-fg-2)", marginBottom: 14 }}>
            Deterministic economic simulation for Solana programs.
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btn btn--ghost btn--sm">
              <Icon name="book2" size={12} />
              Documentation
            </button>
            <button className="btn btn--ghost btn--sm">
              <Icon name="external" size={12} />
              Release notes
            </button>
            <button className="btn btn--ghost btn--sm">
              <Icon name="external" size={12} />
              License (MIT)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
