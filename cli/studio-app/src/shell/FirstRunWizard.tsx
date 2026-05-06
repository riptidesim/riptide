import { useEffect, useState } from "react";

import {
  api,
  ApiError,
  type AgentProbe,
  type ProgramDetection,
  type Protocol,
  type ProtocolChoice,
  type StudioWorkspace
} from "../api";
import { Icon } from "../ui/Icon";
import { Kicker } from "../ui/primitives";

type Step = 0 | 1 | 2;

interface FirstRunWizardProps {
  workspace: StudioWorkspace;
  onDone: (workspaces: StudioWorkspace[]) => void;
}

const PROGRAM_NAME_RE = /^[a-z][a-z0-9-]*$/;

export function FirstRunWizard({ workspace, onDone }: FirstRunWizardProps) {
  const [step, setStep] = useState<Step>(0);
  const [detection, setDetection] = useState<ProgramDetection | null>(null);
  const [detectionLoading, setDetectionLoading] = useState(true);
  const [programName, setProgramName] = useState(defaultProgramName(workspace));
  const [nameTouched, setNameTouched] = useState(false);
  const [protocol, setProtocol] = useState<Protocol>("custom");
  const [agentId, setAgentId] = useState<string>("claude-code");
  const [protocols, setProtocols] = useState<ProtocolChoice[]>([]);
  const [agents, setAgents] = useState<AgentProbe[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [model, setModel] = useState("default");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  function reprobeAgents() {
    setAgentsLoading(true);
    return api
      .agents()
      .then((res) => { setAgents(res.agents); })
      .catch(() => {})
      .finally(() => setAgentsLoading(false));
  }

  useEffect(() => {
    api.protocols().then((res) => setProtocols(res.protocols)).catch(() => {});
  }, []);

  useEffect(() => {
    setDetectionLoading(true);
    api
      .detectProgram()
      .then((res) => {
        setDetection(res);
        if (res.programName) setProgramName(res.programName);
      })
      .catch(() => {})
      .finally(() => setDetectionLoading(false));
  }, []);

  useEffect(() => {
    setAgentsLoading(true);
    api
      .agents()
      .then((res) => {
        setAgents(res.agents);
        const firstDetected = res.agents.find((a) => a.detected);
        if (firstDetected) setAgentId(firstDetected.id);
      })
      .catch(() => {})
      .finally(() => setAgentsLoading(false));
  }, []);

  const programNameValid = PROGRAM_NAME_RE.test(programName);
  const canContinue =
    step === 0 ? programNameValid && protocol.length > 0 : step === 1 ? agents.some((a) => a.id === agentId) : true;

  async function submit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await api.init({ programName, protocol });
      onDone(res.workspaces);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : (err as Error).message;
      setSubmitError(message);
      setSubmitting(false);
    }
  }

  return (
    <div className="scrim">
      <div className="modal" style={{ maxWidth: 920, height: 720 }}>
        <Header step={step} />
        <Stepper step={step} />
        <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
          {step === 0 && (
            <ProjectStep
              workspace={workspace}
              programName={programName}
              setProgramName={(v) => { setProgramName(v); setNameTouched(true); }}
              programNameValid={programNameValid}
              protocol={protocol}
              setProtocol={setProtocol}
              protocols={protocols}
              detection={detection}
              detectionLoading={detectionLoading}
              nameTouched={nameTouched}
              onPickCandidate={(c) => { setProgramName(c); setNameTouched(false); }}
            />
          )}
          {step === 1 && (
            <AgentStep
              agents={agents}
              loading={agentsLoading}
              agentId={agentId}
              setAgentId={setAgentId}
              model={model}
              setModel={setModel}
              onReprobe={reprobeAgents}
            />
          )}
          {step === 2 && (
            <LaunchStep
              workspace={workspace}
              programName={programName}
              protocol={protocol}
              protocolLabel={protocols.find((p) => p.value === protocol)?.label ?? protocol}
              agent={agents.find((a) => a.id === agentId) ?? null}
              error={submitError}
            />
          )}
        </div>
        <Footer
          step={step}
          canContinue={canContinue}
          submitting={submitting}
          onBack={() => setStep((s) => (s > 0 ? ((s - 1) as Step) : s))}
          onNext={() => setStep((s) => (s < 2 ? ((s + 1) as Step) : s))}
          onSubmit={submit}
        />
      </div>
    </div>
  );
}

function Header({ step }: { step: Step }) {
  const titles = ["Name your project", "Connect a coding agent", "Confirm and bootstrap"];
  return (
    <div style={{ padding: "18px 24px", borderBottom: "1px solid var(--rt-slate-line)", display: "flex", alignItems: "center", gap: 14 }}>
      <img src="assets/logo-icon.png" style={{ width: 24, height: 24 }} alt="Riptide" />
      <div style={{ flex: 1 }}>
        <Kicker>FIRST RUN · STEP {step + 1} / 3</Kicker>
        <div style={{ font: "600 16px Inter", color: "var(--rt-off-white)", marginTop: 4 }}>{titles[step]}</div>
      </div>
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  const labels = ["Project", "Agent", "Confirm"];
  return (
    <div style={{ display: "flex", gap: 0, padding: "0 24px", borderBottom: "1px solid var(--rt-slate-line)" }}>
      {labels.map((s, i) => (
        <div key={s} style={{
          flex: 1, padding: "12px 0",
          font: '500 11px "IBM Plex Mono"', letterSpacing: ".16em", textTransform: "uppercase",
          color: i <= step ? "var(--rt-teal)" : "var(--rt-fog-dim)",
          borderBottom: i === step ? "2px solid var(--rt-teal)" : "2px solid transparent",
          textAlign: "center"
        }}>0{i + 1} · {s}</div>
      ))}
    </div>
  );
}

interface ProjectStepProps {
  workspace: StudioWorkspace;
  programName: string;
  setProgramName: (v: string) => void;
  programNameValid: boolean;
  protocol: Protocol;
  setProtocol: (p: Protocol) => void;
  protocols: ProtocolChoice[];
  detection: ProgramDetection | null;
  detectionLoading: boolean;
  nameTouched: boolean;
  onPickCandidate: (programName: string) => void;
}

const SOURCE_LABEL: Record<NonNullable<ProgramDetection["source"]>, string> = {
  anchor: "Anchor.toml",
  "cargo-workspace": "programs/*/Cargo.toml",
  "cargo-package": "Cargo.toml"
};

function ProjectStep({
  workspace, programName, setProgramName, programNameValid,
  protocol, setProtocol, protocols, detection, detectionLoading, nameTouched, onPickCandidate
}: ProjectStepProps) {
  const candidates = detection?.candidates ?? [];
  const detectedName = detection?.programName ?? null;
  const detectedNames = candidates.map((c) => c.programName);
  const isMismatch = !detectionLoading && detectedNames.length > 0 && !detectedNames.includes(programName) && nameTouched;

  return (
    <div>
      <div style={{ font: "400 14px/1.55 Inter", color: "var(--rt-fg-2)", marginBottom: 18, maxWidth: 580 }}>
        Riptide will scaffold a thin <span style={{ color: "var(--rt-teal)", fontFamily: "IBM Plex Mono" }}>.riptide/</span>{" "}
        directory in this folder. You'll fill it in yourself — personas, scenarios, invariants — once setup is done.
      </div>

      <div style={{
        padding: 14, background: "var(--rt-slate-2)", border: "1px solid var(--rt-slate-line)",
        borderRadius: 8, marginBottom: 22, display: "flex", alignItems: "center", gap: 10
      }}>
        <Icon name="folder" size={14} color="var(--rt-fog-dim)" />
        <div style={{ flex: 1 }}>
          <div style={{ font: '500 10px "IBM Plex Mono"', color: "var(--rt-fog-dim)", letterSpacing: "0.08em", marginBottom: 2 }}>
            WORKSPACE
          </div>
          <div style={{ font: '500 12.5px "IBM Plex Mono"', color: "var(--rt-off-white)" }}>
            {basenameOf(workspace.path)}
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 18 }}>
        <label style={{ display: "block", font: '500 10px "IBM Plex Mono"', color: "var(--rt-fog-dim)", letterSpacing: "0.08em", marginBottom: 6 }}>
          PROGRAM NAME
        </label>
        <input
          className="input"
          value={programName}
          onChange={(e) => setProgramName(e.target.value)}
          placeholder="my-program"
          style={{ width: "100%", maxWidth: 380, fontFamily: "IBM Plex Mono" }}
        />
        <DetectionHint
          detection={detection}
          detectionLoading={detectionLoading}
          isMismatch={isMismatch}
          detectedName={detectedName}
          programNameValid={programNameValid}
        />
        {candidates.length > 1 && (
          <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ font: '500 10px "IBM Plex Mono"', color: "var(--rt-fog-dim)", letterSpacing: "0.08em" }}>
              CANDIDATES
            </span>
            {candidates.map((c) => (
              <button
                key={c.programName}
                type="button"
                onClick={() => onPickCandidate(c.programName)}
                className={`chip${programName === c.programName ? " chip--active" : ""}`}
                title={c.programName}
              >{c.programName}</button>
            ))}
          </div>
        )}
      </div>

      <div>
        <label style={{ display: "block", font: '500 10px "IBM Plex Mono"', color: "var(--rt-fog-dim)", letterSpacing: "0.08em", marginBottom: 6 }}>
          PROTOCOL CLASS
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, maxWidth: 720 }}>
          {protocols.map((p) => (
            <button
              key={p.value}
              onClick={() => setProtocol(p.value)}
              style={{
                background: protocol === p.value ? "rgba(20,184,182,0.06)" : "var(--rt-slate-panel)",
                border: protocol === p.value ? "1px solid var(--rt-teal)" : "1px solid var(--rt-slate-line)",
                boxShadow: protocol === p.value ? "0 0 0 3px rgba(20,184,182,0.10)" : "none",
                borderRadius: 8, padding: "12px 14px", textAlign: "left", cursor: "pointer",
                font: "500 13px Inter", color: protocol === p.value ? "var(--rt-off-white)" : "var(--rt-fg-2)"
              }}
            >{p.label}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

interface DetectionHintProps {
  detection: ProgramDetection | null;
  detectionLoading: boolean;
  isMismatch: boolean;
  detectedName: string | null;
  programNameValid: boolean;
}

function DetectionHint({ detection, detectionLoading, isMismatch, detectedName, programNameValid }: DetectionHintProps) {
  if (!programNameValid) {
    return <div style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fail)", marginTop: 6 }}>
      lowercase letters, numbers, dashes; must start with a letter
    </div>;
  }
  if (detectionLoading) {
    return <div style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)", marginTop: 6 }}>
      scanning Anchor.toml + Cargo.toml…
    </div>;
  }
  if (isMismatch && detection) {
    const names = detection.candidates.map((c) => c.programName).join(", ");
    return <div style={{ font: '400 11px/1.5 "IBM Plex Mono"', color: "var(--rt-warn)", marginTop: 6, maxWidth: 560 }}>
      ⚠ doesn't match what Riptide detected ({names}). `riptide validate` and `riptide run` look for
      target/deploy/&lt;name&gt;.so and target/idl/&lt;name&gt;.json — they won't find your binary at this name.
    </div>;
  }
  if (detectedName && detection?.source) {
    return <div style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-teal)", marginTop: 6 }}>
      ✓ detected from {SOURCE_LABEL[detection.source]}
    </div>;
  }
  return <div style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)", marginTop: 6 }}>
    no Anchor.toml or programs/*/Cargo.toml found — using directory name as a guess
  </div>;
}

interface AgentStepProps {
  agents: AgentProbe[];
  loading: boolean;
  agentId: string;
  setAgentId: (id: string) => void;
  model: string;
  setModel: (m: string) => void;
  onReprobe: () => Promise<void>;
}

const AGENT_TAGLINE: Record<string, string> = {
  "claude-code": "Local Claude agent",
  codex: "Local Codex agent",
  gemini: "Local Gemini agent",
  cursor: "Local Cursor agent",
  opencode: "Local multi-provider agent"
};

const MODEL_OPTIONS: Record<string, string[]> = {
  "claude-code": [
    "default",
    "claude-haiku-4.5",
    "claude-haiku-4.6",
    "claude-opus-4.6",
    "claude-opus-4.7",
    "claude-sonnet-4.5",
    "claude-sonnet-4.6"
  ],
  codex: [
    "default",
    "codex-mini",
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-5.3-codex",
    "gpt-5.3-codex-spark",
    "gpt-5.4",
    "o3",
    "o3-mini",
    "o4-mini"
  ],
  gemini: [
    "default",
    "auto",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-pro"
  ],
  cursor: [
    "default",
    "auto",
    "composer-1",
    "composer-1.5",
    "gemini-3-flash",
    "gemini-3-pro",
    "gemini-3.1-pro",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-max-high",
    "gpt-5.1-codex-mini",
    "gpt-5.1-high",
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.2-codex-fast",
    "gpt-5.2-codex-high",
    "gpt-5.2-codex-high-fast"
  ],
  opencode: [
    "default",
    "gpt-5-codex",
    "gpt-5.1-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
    "gpt-5.2",
    "gpt-5.2-codex",
    "gpt-5.3-codex",
    "gpt-5.4",
    "gpt-5.4-mini",
    "big-pickle",
    "gpt-5-nano",
    "hy3-preview-free",
    "minimax-m2.5-free",
    "nemotron-3-super-free"
  ]
};

const MODEL_LABEL: Record<string, string> = {
  default: "Default",
  auto: "Auto",
  "claude-haiku-4.5": "Claude Haiku 4.5",
  "claude-haiku-4.6": "Claude Haiku 4.6",
  "claude-opus-4.6": "Claude Opus 4.6",
  "claude-opus-4.7": "Claude Opus 4.7",
  "claude-sonnet-4.5": "Claude Sonnet 4.5",
  "claude-sonnet-4.6": "Claude Sonnet 4.6",
  "codex-mini": "Codex Mini",
  "gemini-2.0-flash": "Gemini 2.0 Flash",
  "gemini-2.0-flash-lite": "Gemini 2.0 Flash Lite",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "gemini-2.5-flash-lite": "Gemini 2.5 Flash Lite",
  "gemini-2.5-pro": "Gemini 2.5 Pro"
};

const AGENT_ICON: Record<string, "sparkles" | "code" | "gem" | "cursorArrow" | "terminalSquare"> = {
  "claude-code": "sparkles",
  codex: "code",
  gemini: "gem",
  cursor: "cursorArrow",
  opencode: "terminalSquare"
};

function AgentStep({ agents, loading, agentId, setAgentId, model, setModel, onReprobe }: AgentStepProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeMessage, setProbeMessage] = useState<string | null>(null);

  const recommended = agents.filter((a) => a.recommended);
  const others = agents.filter((a) => !a.recommended);
  const selected = agents.find((a) => a.id === agentId) ?? null;
  const modelChoices = MODEL_OPTIONS[agentId] ?? ["default"];

  async function runProbe() {
    setProbing(true);
    setProbeMessage(null);
    try {
      await onReprobe();
      setProbeMessage("Probe complete. Detected agents updated.");
    } catch (err) {
      setProbeMessage((err as Error).message);
    } finally {
      setProbing(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 14, marginBottom: 20 }}>
        <div style={{
          width: 36, height: 36, borderRadius: 8, background: "var(--rt-slate-2)",
          border: "1px solid var(--rt-slate-line)", display: "flex", alignItems: "center", justifyContent: "center"
        }}>
          <Icon name="sparkles" size={16} color="var(--rt-teal)" />
        </div>
        <div>
          <div style={{ font: "600 16px Inter", color: "var(--rt-off-white)" }}>Connect a coding agent</div>
          <div style={{ font: "400 13px Inter", color: "var(--rt-fg-2)", marginTop: 3 }}>
            Studio sends authoring tasks (drafting personas, scenarios, invariants) to a local agent CLI.
          </div>
        </div>
      </div>

      {loading ? (
        <ProbingSkeleton />
      ) : (
        <>
          <div style={{ font: '500 10px "IBM Plex Mono"', color: "var(--rt-fog-dim)", letterSpacing: "0.08em", marginBottom: 8 }}>
            ADAPTER TYPE
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
            {recommended.map((a) => (
              <AgentCard key={a.id} agent={a} tagline={AGENT_TAGLINE[a.id] ?? a.label}
                selected={agentId === a.id} onSelect={() => a.detected && setAgentId(a.id)} showRecommended
                iconName={AGENT_ICON[a.id] ?? "sparkles"} />
            ))}
          </div>

          <button type="button" onClick={() => setMoreOpen((v) => !v)}
            style={{
              display: "flex", alignItems: "center", gap: 8, background: "transparent",
              border: "none", color: "var(--rt-fog)", cursor: "pointer", padding: "10px 0", font: "500 13px Inter"
            }}>
            <Icon name="chevron" size={12}
              style={{ transition: "transform 120ms", transform: moreOpen ? "rotate(90deg)" : "rotate(0deg)" }} />
            More Agent Adapter Types
          </button>

          {moreOpen && others.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
              {others.map((a) => (
                <AgentCard key={a.id} agent={a} tagline={AGENT_TAGLINE[a.id] ?? a.label}
                  selected={agentId === a.id} onSelect={() => a.detected && setAgentId(a.id)}
                  iconName={AGENT_ICON[a.id] ?? "sparkles"} />
              ))}
            </div>
          )}

          <div style={{ font: '500 10px "IBM Plex Mono"', color: "var(--rt-fog-dim)", letterSpacing: "0.08em", margin: "20px 0 6px" }}>
            MODEL
          </div>
          <select className="select" value={model} onChange={(e) => setModel(e.target.value)} style={{ maxWidth: 380 }}>
            {modelChoices.map((m) => (
              <option key={m} value={m}>{MODEL_LABEL[m] ?? m}</option>
            ))}
          </select>

          <div className="card" style={{ marginTop: 22, padding: 16, display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ flex: 1 }}>
              <div style={{ font: "500 13px Inter", color: "var(--rt-off-white)", marginBottom: 4 }}>
                Adapter environment check
              </div>
              <div style={{ font: "400 12px Inter", color: "var(--rt-fg-2)" }}>
                Re-probes for {selected?.label ?? "the selected agent"} and reports its version.
              </div>
              {probeMessage && (
                <div style={{
                  font: '400 11px "IBM Plex Mono"',
                  color: probing ? "var(--rt-fog-dim)" : "var(--rt-teal)",
                  marginTop: 6
                }}>{probeMessage}</div>
              )}
            </div>
            <button className="btn btn--ghost btn--sm" onClick={runProbe} disabled={probing}>
              <Icon name={probing ? "refresh" : "cpu"} size={12} />
              {probing ? "Probing…" : "Test now"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

interface AgentCardProps {
  agent: AgentProbe;
  tagline: string;
  selected: boolean;
  onSelect: () => void;
  showRecommended?: boolean;
  iconName: "sparkles" | "code" | "gem" | "cursorArrow" | "terminalSquare";
}

function AgentCard({ agent, tagline, selected, onSelect, showRecommended, iconName }: AgentCardProps) {
  const disabled = !agent.detected;
  return (
    <div style={{ position: "relative", paddingTop: 10 }}>
      {showRecommended && agent.detected && (
        <span style={{
          position: "absolute", top: 0, left: "50%", transform: "translateX(-50%)",
          font: '600 10px "IBM Plex Mono"', letterSpacing: "0.04em",
          background: "rgba(34,197,94,0.16)", color: "var(--rt-pass)",
          border: "1px solid rgba(34,197,94,0.35)", padding: "2px 10px", borderRadius: 999,
          zIndex: 2, whiteSpace: "nowrap"
        }}>Recommended</span>
      )}
      <button onClick={onSelect} disabled={disabled} style={{
        position: "relative", background: "var(--rt-slate-panel)",
        border: selected ? "1px solid var(--rt-teal)" : "1px solid var(--rt-slate-line)",
        boxShadow: selected ? "0 0 0 3px rgba(20,184,182,0.10)" : "none",
        borderRadius: 10, padding: "22px 14px 18px", textAlign: "center",
        cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1,
        display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
        minHeight: 132, width: "100%"
      }}>
      <Icon name={iconName} size={22} color={selected ? "var(--rt-teal)" : "var(--rt-fog)"} />
      <div style={{ font: "600 15px Inter", color: "var(--rt-off-white)" }}>{agent.label}</div>
      <div style={{ font: "400 12px Inter", color: "var(--rt-fog-dim)" }}>{tagline}</div>
      {!agent.detected && (
        <div style={{ font: '400 10px "IBM Plex Mono"', color: "var(--rt-fog-faint)", marginTop: 2 }}>
          not detected on PATH
        </div>
      )}
      </button>
    </div>
  );
}

function ProbingSkeleton() {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "18px 14px", background: "var(--rt-slate-2)",
      border: "1px solid var(--rt-slate-line)", borderRadius: 8, color: "var(--rt-fog-dim)"
    }}>
      <Icon name="refresh" size={14} />
      <span style={{ font: "400 13px Inter" }}>Probing your PATH…</span>
    </div>
  );
}

interface LaunchStepProps {
  workspace: StudioWorkspace;
  programName: string;
  protocol: Protocol;
  protocolLabel: string;
  agent: AgentProbe | null;
  error: string | null;
}

function LaunchStep({ workspace, programName, protocol, protocolLabel, agent, error }: LaunchStepProps) {
  const _ = protocol;
  void _;
  return (
    <div>
      <div style={{ font: "400 14px/1.55 Inter", color: "var(--rt-fg-2)", marginBottom: 22, maxWidth: 580 }}>
        Riptide is about to write a thin scaffold. Nothing else changes — no compile, no network, no edits outside{" "}
        <span style={{ color: "var(--rt-teal)", fontFamily: "IBM Plex Mono" }}>.riptide/</span>.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 18 }}>
        <div className="card" style={{ padding: 18 }}>
          <Kicker style={{ marginBottom: 8 }}>WORKSPACE</Kicker>
          <div style={{ font: "500 16px Inter", color: "var(--rt-off-white)", marginBottom: 4 }}>{programName}</div>
          <div style={{ font: '400 12px "IBM Plex Mono"', color: "var(--rt-fog-dim)" }}>
            {basenameOf(workspace.path)}
          </div>
          <div style={{ font: "400 12px Inter", color: "var(--rt-fog-dim)", marginTop: 8 }}>
            class · {protocolLabel}
          </div>
        </div>
        <div className="card" style={{ padding: 18 }}>
          <Kicker style={{ marginBottom: 8 }}>AGENT</Kicker>
          <div style={{
            font: "500 16px Inter", color: "var(--rt-off-white)", marginBottom: 4,
            display: "flex", alignItems: "center", gap: 8
          }}>
            {agent?.label ?? "—"}
            {agent && <span className={`dot dot--${agent.detected ? "pass" : "queued"}`} />}
          </div>
          <div style={{ font: "400 12px Inter", color: "var(--rt-fog-dim)" }}>
            {agent?.detected
              ? agent.version ? `local agent · v${agent.version}` : "local agent"
              : "not configured"}
          </div>
        </div>
      </div>
      <div className="card" style={{ padding: 18, marginBottom: 14 }}>
        <Kicker style={{ marginBottom: 8 }}>WILL CREATE</Kicker>
        <div className="code" style={{ background: "transparent", border: "none", padding: 0 }}>
{`.riptide/
  adapters/${programName}.toml
  scenarios/         (empty — fill in)
  GETTING-STARTED.md`}
        </div>
      </div>
      {error && (
        <div className="card" style={{ padding: 14, border: "1px solid rgba(239,68,68,0.35)", background: "rgba(239,68,68,0.06)" }}>
          <Kicker style={{ marginBottom: 6, color: "var(--rt-fail)" }}>BOOTSTRAP FAILED</Kicker>
          <div style={{ font: '400 12.5px "IBM Plex Mono"', color: "var(--rt-fail)" }}>{error}</div>
        </div>
      )}
    </div>
  );
}

interface FooterProps {
  step: Step;
  canContinue: boolean;
  submitting: boolean;
  onBack: () => void;
  onNext: () => void;
  onSubmit: () => void;
}

function Footer({ step, canContinue, submitting, onBack, onNext, onSubmit }: FooterProps) {
  return (
    <div style={{ padding: "14px 24px", borderTop: "1px solid var(--rt-slate-line)", display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-faint)" }}>
        {submitting && "Bootstrapping…"}
      </div>
      {step > 0 && !submitting && (
        <button className="btn btn--ghost btn--sm" onClick={onBack}>Back</button>
      )}
      {step < 2 ? (
        <button className="btn btn--primary btn--sm" onClick={onNext} disabled={!canContinue}>
          Continue<Icon name="chevron" size={13} />
        </button>
      ) : (
        <button className="btn btn--primary btn--sm" onClick={onSubmit} disabled={submitting}>
          {submitting ? <Icon name="refresh" size={13} /> : <Icon name="play" size={13} />}
          {submitting ? "Bootstrapping…" : "Bootstrap workspace"}
        </button>
      )}
    </div>
  );
}

function basenameOf(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

function defaultProgramName(workspace: StudioWorkspace): string {
  const base = workspace.path.split("/").filter(Boolean).pop() ?? "my-program";
  const slug = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (PROGRAM_NAME_RE.test(slug)) return slug;
  return "my-program";
}
