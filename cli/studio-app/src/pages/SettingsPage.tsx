import { useEffect, useState } from "react";

import { api, type AgentProbe, type ProgramDetection, type StudioWorkspace } from "../api";
import type { AgentPreference } from "../agentMeta";
import { labelForModel, modelOptionsFor } from "../agentMeta";
import type { ConfigIntentResponse } from "../studioTypes";
import { Icon } from "../ui/Icon";
import { Kicker, PageLabel, Pill } from "../ui/primitives";
import { TabStrip } from "../ui/TabStrip";

type SettingsTab = "agents" | "workspace" | "about";

interface SettingsPageProps {
  agents: AgentProbe[];
  onReprobe: () => Promise<AgentProbe[]>;
  workspace: StudioWorkspace;
  pref: AgentPreference | null;
  setPref: (next: AgentPreference) => void;
}

function adapterDot(agent: AgentProbe): "pass" | "queued" | "fail" {
  return agent.detected ? "pass" : "fail";
}

function adapterDetail(agent: AgentProbe): string {
  if (!agent.detected) return "CLI not on PATH";
  return agent.path ?? agent.binary;
}

export function SettingsPage({ agents, onReprobe, workspace, pref, setPref }: SettingsPageProps) {
  const [tab, setTab] = useState<SettingsTab>("agents");
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<{ kind: "ok" | "fail"; text: string; at: Date } | null>(null);
  const [detection, setDetection] = useState<ProgramDetection | null>(null);
  const [detectionError, setDetectionError] = useState<string | null>(null);
  const [intentBusy, setIntentBusy] = useState(false);
  const [intentError, setIntentError] = useState<string | null>(null);
  const [intent, setIntent] = useState<ConfigIntentResponse | null>(null);
  const [protocolClass, setProtocolClass] = useState("lending");
  const [riskGoal, setRiskGoal] = useState("map economic failure modes");
  const [scenarioTarget, setScenarioTarget] = useState("smoke");
  const [evidenceBoundary, setEvidenceBoundary] = useState("current-state-only");
  const [notes, setNotes] = useState("");

  const resolvedActiveId = pref?.agentId ?? agents.find((a) => a.detected)?.id ?? null;
  const currentModel = pref?.model ?? "default";
  const activeModelChoices = resolvedActiveId ? modelOptionsFor(resolvedActiveId) : ["default"];

  useEffect(() => {
    let cancelled = false;
    setDetection(null);
    setDetectionError(null);
    api.detectProgram()
      .then((res) => {
        if (!cancelled) setDetection(res);
      })
      .catch((err) => {
        if (!cancelled) setDetectionError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace.id]);

  async function probe() {
    setProbing(true);
    setProbeResult(null);
    const startedAt = Date.now();
    try {
      const fresh = await onReprobe();
      // Hold the spinner state for a minimum so a fast probe is still perceptible.
      const elapsed = Date.now() - startedAt;
      if (elapsed < 350) await new Promise((r) => setTimeout(r, 350 - elapsed));
      const detected = fresh.filter((a) => a.detected).length;
      const total = fresh.length;
      setProbeResult({
        kind: "ok",
        text: total === 0
          ? "Probe complete."
          : `Probe complete — ${detected}/${total} detected.`,
        at: new Date()
      });
    } catch (err) {
      setProbeResult({ kind: "fail", text: (err as Error).message || "Probe failed.", at: new Date() });
    } finally {
      setProbing(false);
    }
  }

  async function generateIntent() {
    setIntentBusy(true);
    setIntentError(null);
    setIntent(null);
    try {
      const res = await api.config.intent({
        workspace_id: workspace.id,
        protocol_class: protocolClass,
        repo_path: workspace.path,
        risk_goal: riskGoal,
        scenario_target: scenarioTarget,
        evidence_boundary: evidenceBoundary,
        notes
      });
      setIntent(res);
    } catch (err) {
      setIntentError((err as Error).message);
    } finally {
      setIntentBusy(false);
    }
  }

  return (
    <div>
      <PageLabel>SETTINGS</PageLabel>
      <TabStrip
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "agents", label: "Agents" },
          { id: "workspace", label: "Workspace" },
          { id: "about", label: "About" }
        ]}
      />
      {tab === "agents" && (
        <div className="card" style={{ padding: 24, maxWidth: 880 }}>
          <Kicker style={{ marginBottom: 8 }}>CODING AGENTS</Kicker>
          <div style={{ font: "500 16px Inter", color: "var(--rt-off-white)", marginBottom: 4 }}>Agent CLI selection</div>
          <div style={{ font: "400 13px Inter", color: "var(--rt-fg-2)", marginBottom: 14 }}>
            Studio sends authoring tasks to a locally-installed coding agent.
          </div>
          {agents.length === 0 && (
            <div style={{
              padding: "12px 14px", background: "var(--rt-slate-2)", borderRadius: 6,
              font: '400 12px "IBM Plex Mono"', color: "var(--rt-fog-dim)"
            }}>probing PATH…</div>
          )}
          {agents.map((a) => {
            const isActive = resolvedActiveId === a.id;
            const dot = adapterDot(a);
            return (
              <div
                key={a.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "12px 14px",
                  background: "var(--rt-slate-2)",
                  borderRadius: 6,
                  marginBottom: 6,
                  border: isActive ? "1px solid var(--rt-teal)" : "1px solid transparent"
                }}
              >
                <span className={`dot dot--${dot}`} />
                <div style={{ flex: 1 }}>
                  <div style={{ font: "500 13px Inter", color: "var(--rt-off-white)" }}>{a.label}</div>
                  <div style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)", marginTop: 2 }}>
                    {adapterDetail(a)}
                  </div>
                </div>
                {isActive && (
                  <>
                    <select
                      className="select"
                      value={currentModel}
                      onChange={(e) => setPref({ agentId: a.id, model: e.target.value })}
                      style={{ minWidth: 200 }}
                      title="Model for this agent"
                    >
                      {activeModelChoices.map((m) => (
                        <option key={m} value={m}>{labelForModel(m)}</option>
                      ))}
                    </select>
                    <Pill kind="info">ACTIVE</Pill>
                  </>
                )}
                {!isActive && a.detected && (
                  <button
                    className="btn btn--ghost btn--sm"
                    onClick={() => setPref({ agentId: a.id, model: "default" })}
                  >Use</button>
                )}
              </div>
            );
          })}
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
              <button className="btn btn--ghost btn--sm" onClick={probe} disabled={probing}>
                <Icon name={probing ? "refresh" : "cpu"} size={12} />
                {probing ? "Testing…" : "Test now"}
              </button>
            </div>
            {probeResult && (
              <div style={{
                marginTop: 10,
                font: '400 11.5px "IBM Plex Mono"',
                color: probeResult.kind === "ok" ? "var(--rt-teal)" : "var(--rt-fail)"
              }}>
                {probeResult.kind === "ok" ? "✓ " : "✗ "}{probeResult.text}{" "}
                <span style={{ color: "var(--rt-fog-dim)" }}>
                  · {probeResult.at.toLocaleTimeString()}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
      {tab === "workspace" && (
        <div className="card" style={{ padding: 24, maxWidth: 880 }}>
          <Kicker style={{ marginBottom: 8 }}>WORKSPACE</Kicker>
          <div style={{ font: "500 16px Inter", color: "var(--rt-off-white)", marginBottom: 4 }}>Paths</div>
          <div style={{ font: "400 13px Inter", color: "var(--rt-fg-2)", marginBottom: 14 }}>
            Where Riptide is reading and writing for this project.
          </div>
          <table className="ptable">
            <tbody>
              <tr><td>name</td><td>{workspace.label}</td></tr>
              <tr><td>workspace</td><td>{workspace.path}</td></tr>
              <tr><td>.riptide/</td><td>{workspace.riptide_path}</td></tr>
              <tr><td>source</td><td>{workspace.source === "case-study" ? "case study" : "current directory"}</td></tr>
              <tr><td>scaffold</td><td>{workspace.has_riptide ? "present" : "not initialized"}</td></tr>
            </tbody>
          </table>

          <div style={{ height: 1, background: "var(--rt-slate-line)", margin: "22px 0" }} />

          <Kicker style={{ marginBottom: 8 }}>DETECTED PROGRAM</Kicker>
          {detectionError && <div style={{ color: "var(--rt-fail)", font: "400 13px Inter", marginBottom: 12 }}>{detectionError}</div>}
          {!detection && !detectionError && (
            <div style={{ color: "var(--rt-fog-dim)", font: "400 13px Inter", marginBottom: 12 }}>Detecting program...</div>
          )}
          {detection && (
            <table className="ptable" style={{ marginBottom: 20 }}>
              <tbody>
                <tr><td>program</td><td>{detection.programName ?? "not detected"}</td></tr>
                <tr><td>source</td><td>{detection.source ?? "n/a"}</td></tr>
                <tr><td>manifest</td><td>{detection.manifestPath ?? "n/a"}</td></tr>
                <tr><td>candidates</td><td>{detection.candidates.length}</td></tr>
              </tbody>
            </table>
          )}

          <Kicker style={{ marginBottom: 8 }}>RIPTIDE-CONFIG HANDOFF</Kicker>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
            <label className="field-label">
              protocol class
              <select className="select" value={protocolClass} onChange={(e) => setProtocolClass(e.target.value)}>
                {["lending", "amm", "perps", "vault", "stablecoin", "yield", "bridge", "other"].map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </label>
            <label className="field-label">
              evidence boundary
              <select className="select" value={evidenceBoundary} onChange={(e) => setEvidenceBoundary(e.target.value)}>
                {["current-state-only", "current-state-plus-replay", "campaign-grid", "guided-sim", "case-study"].map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </label>
            <label className="field-label">
              risk goal
              <input className="input" value={riskGoal} onChange={(e) => setRiskGoal(e.target.value)} />
            </label>
            <label className="field-label">
              scenario target
              <input className="input" value={scenarioTarget} onChange={(e) => setScenarioTarget(e.target.value)} />
            </label>
          </div>
          <label className="field-label">
            notes
            <textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
          </label>
          <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "12px 0 16px" }}>
            <button className="btn btn--primary btn--sm" onClick={generateIntent} disabled={intentBusy}>
              <Icon name="handoff" size={13} />
              {intentBusy ? "Generating..." : "Generate riptide-config handoff"}
            </button>
            {intentError && <span style={{ color: "var(--rt-fail)", font: "400 12px Inter" }}>{intentError}</span>}
          </div>
          {intent && (
            <div style={{ display: "grid", gap: 12 }}>
              <div>
                <Kicker style={{ marginBottom: 8 }}>PROPOSED FILES</Kicker>
                <table className="ptable">
                  <tbody>
                    {intent.proposed_files.map((file) => (
                      <tr key={file.path}><td>{file.path}</td><td>{file.purpose}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <Kicker style={{ marginBottom: 8 }}>HANDOFF PROMPT</Kicker>
                <pre className="code" style={{ whiteSpace: "pre-wrap" }}>{intent.handoff_prompt}</pre>
              </div>
            </div>
          )}
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
                v0.7.0 · engine riptide-sim 0.7.0
              </div>
            </div>
          </div>
          <div style={{ font: "400 13px/1.6 Inter", color: "var(--rt-fg-2)", marginBottom: 14 }}>
            Deterministic economic simulation for Solana programs.
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <a className="btn btn--ghost btn--sm"
              href="https://github.com/riptidesim/riptide" target="_blank" rel="noopener noreferrer">
              <Icon name="external" size={12} />
              GitHub
            </a>
            <a className="btn btn--ghost btn--sm"
              href="https://github.com/riptidesim/riptide/releases" target="_blank" rel="noopener noreferrer">
              <Icon name="external" size={12} />
              Release notes
            </a>
            <a className="btn btn--ghost btn--sm"
              href="https://github.com/riptidesim/riptide/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">
              <Icon name="external" size={12} />
              License (MIT / Apache-2.0)
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
