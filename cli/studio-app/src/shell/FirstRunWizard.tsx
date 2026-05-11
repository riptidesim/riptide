import { useEffect, useMemo, useState } from "react";

import {
  api,
  ApiError,
  type AgentProbe,
  type ProgramDetection,
  type Protocol,
  type ProtocolChoice,
  type StudioWorkspace
} from "../api";
import { Icon, type IconName } from "../ui/Icon";
import { Kicker } from "../ui/primitives";
import { AGENT_TAGLINE, AGENT_ICON, MODEL_OPTIONS, MODEL_LABEL } from "../agentMeta";
import {
  DirectoryBrowser,
  FolderHint,
  basename as pathBasename,
  deriveProgramName,
  folderValidationError,
  samePath
} from "./AddProjectWizard";

type Step = 0 | 1 | 2;

interface FirstRunWizardProps {
  workspace: StudioWorkspace;
  onDone: (workspaces: StudioWorkspace[], activeWorkspaceId?: string | null) => void;
  onPickAgent?: (pref: { agentId: string; model: string }) => void;
}

const PROGRAM_NAME_RE = /^[a-z][a-z0-9-]*$/;

export function FirstRunWizard({ workspace, onDone, onPickAgent }: FirstRunWizardProps) {
  const [step, setStep] = useState<Step>(0);
  const [targetPath, setTargetPath] = useState(workspace.path);
  const [targetTouched, setTargetTouched] = useState(false);
  const [folderPickMessage, setFolderPickMessage] = useState<string | null>(null);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserPath, setBrowserPath] = useState("");
  const [browserEntries, setBrowserEntries] = useState<Array<{ name: string; path: string }>>([]);
  const [browserParent, setBrowserParent] = useState<string | null>(null);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserError, setBrowserError] = useState<string | null>(null);
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
  const [agentProbing, setAgentProbing] = useState(false);
  const existingRiptide = workspace.has_riptide;
  const targetFolderError = useMemo(() => folderValidationError(targetPath), [targetPath]);
  const targetFolderValid = targetFolderError === null && targetPath.trim().length > 0;
  const targetLabel = pathBasename(targetPath.trim()) || workspace.label;

  function reprobeAgents() {
    return api
      .agents()
      .then((res) => { setAgents(res.agents); });
  }

  useEffect(() => {
    api.protocols().then((res) => setProtocols(res.protocols)).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    setDetectionLoading(true);
    const path = targetPath.trim() || workspace.path;
    if (folderValidationError(path)) {
      setDetection(null);
      setDetectionLoading(false);
      return () => { cancelled = true; };
    }
    api
      .detectProgram(undefined, path)
      .then((res) => {
        if (cancelled) return;
        setDetection(res);
        if (res.programName && !nameTouched) setProgramName(res.programName);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setDetectionLoading(false);
      });
    return () => { cancelled = true; };
  }, [targetPath, workspace.path, nameTouched]);

  useEffect(() => {
    if (!nameTouched) {
      const derived = deriveProgramName(targetPath.trim() || workspace.path);
      setProgramName(derived || defaultProgramName(workspace));
    }
  }, [nameTouched, targetPath, workspace.path]);

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
    step === 0 ? targetFolderValid && programNameValid && protocol.length > 0 && !pickingFolder
    : step === 1 ? agents.some((a) => a.id === agentId) && !agentProbing
    : true;

  async function submit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const trimmed = targetPath.trim() || workspace.path;
      const res = await api.init({
        programName,
        protocol,
        path: trimmed,
        label: pathBasename(trimmed) || programName
      });
      const selected = res.workspaces.find((w) => samePath(w.path, trimmed)) ?? null;
      onPickAgent?.({ agentId, model });
      onDone(res.workspaces, selected?.id ?? null);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : (err as Error).message;
      setSubmitError(message);
      setSubmitting(false);
    }
  }

  async function loadBrowserDirectory(path?: string) {
    setBrowserLoading(true);
    setBrowserError(null);
    try {
      const res = await api.browseDirectory(path);
      setBrowserPath(res.path);
      setBrowserParent(res.parent);
      setBrowserEntries(res.entries);
    } catch (err) {
      setBrowserError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBrowserLoading(false);
    }
  }

  async function pickFolder() {
    if (submitting || pickingFolder) return;
    setPickingFolder(true);
    setFolderPickMessage(null);
    try {
      const native = await api.pickDirectory();
      if (native.cancelled) return;
      if (native.path) {
        setTargetPath(native.path);
        setTargetTouched(true);
        setFolderPickMessage("selected via OS folder picker");
        return;
      }
      if (native.message) setFolderPickMessage(native.message);
      setBrowserOpen(true);
      await loadBrowserDirectory(targetFolderValid ? targetPath.trim() : undefined);
    } catch (err) {
      setFolderPickMessage((err as Error).message);
      setBrowserOpen(true);
      try {
        await loadBrowserDirectory(targetFolderValid ? targetPath.trim() : undefined);
      } catch {
        // DirectoryBrowser renders the loading error.
      }
    } finally {
      setPickingFolder(false);
    }
  }

  function useBrowserPath() {
    if (!browserPath) return;
    setTargetPath(browserPath);
    setTargetTouched(true);
    setFolderPickMessage("selected from workspace browser");
    setBrowserOpen(false);
  }

  return (
    <div className="scrim">
      <div className="modal" style={{ maxWidth: 920 }}>
        <Header step={step} existingRiptide={existingRiptide} />
        <Stepper step={step} />
        <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
          {step === 0 && (
            <ProjectStep
              targetPath={targetPath}
              setTargetPath={(next) => {
                setTargetPath(next);
                setTargetTouched(true);
                setFolderPickMessage(null);
              }}
              targetTouched={targetTouched}
              targetFolderError={targetFolderError}
              targetFolderValid={targetFolderValid}
              pickingFolder={pickingFolder}
              folderPickMessage={folderPickMessage}
              browserOpen={browserOpen}
              browserPath={browserPath}
              browserParent={browserParent}
              browserEntries={browserEntries}
              browserLoading={browserLoading}
              browserError={browserError}
              onPickFolder={() => void pickFolder()}
              onCloseBrowser={() => setBrowserOpen(false)}
              onRefreshBrowser={() => void loadBrowserDirectory(browserPath)}
              onNavigateBrowser={(next) => void loadBrowserDirectory(next)}
              onUseBrowserPath={useBrowserPath}
              programName={programName}
              setProgramName={(v) => { setProgramName(v); setNameTouched(true); }}
              programNameValid={programNameValid}
              protocol={protocol}
              setProtocol={setProtocol}
              protocols={protocols}
              detection={detection}
              detectionLoading={detectionLoading}
              nameTouched={nameTouched}
              onPickCandidate={(c) => { setProgramName(c); setNameTouched(true); }}
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
              onProbingChange={setAgentProbing}
            />
          )}
          {step === 2 && (
            <LaunchStep
              targetPath={targetPath}
              targetLabel={targetLabel}
              programName={programName}
              protocol={protocol}
              protocolLabel={protocols.find((p) => p.value === protocol)?.label ?? protocol}
              agent={agents.find((a) => a.id === agentId) ?? null}
              error={submitError}
              existingRiptide={existingRiptide}
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

function Header({ step, existingRiptide }: { step: Step; existingRiptide: boolean }) {
  const titles = existingRiptide
    ? ["Choose project folder", "Connect a coding agent", "Save workspace"]
    : ["Choose project folder", "Connect a coding agent", "Confirm setup"];
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
  targetPath: string;
  setTargetPath: (v: string) => void;
  targetTouched: boolean;
  targetFolderError: string | null;
  targetFolderValid: boolean;
  pickingFolder: boolean;
  folderPickMessage: string | null;
  browserOpen: boolean;
  browserPath: string;
  browserParent: string | null;
  browserEntries: Array<{ name: string; path: string }>;
  browserLoading: boolean;
  browserError: string | null;
  onPickFolder: () => void;
  onCloseBrowser: () => void;
  onRefreshBrowser: () => void;
  onNavigateBrowser: (path: string) => void;
  onUseBrowserPath: () => void;
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
  targetPath, setTargetPath, targetTouched, targetFolderError, targetFolderValid, pickingFolder,
  folderPickMessage, browserOpen, browserPath, browserParent, browserEntries, browserLoading, browserError,
  onPickFolder, onCloseBrowser, onRefreshBrowser, onNavigateBrowser, onUseBrowserPath,
  programName, setProgramName, programNameValid,
  protocol, setProtocol, protocols, detection, detectionLoading, nameTouched, onPickCandidate
}: ProjectStepProps) {
  const candidates = detection?.candidates ?? [];
  const detectedName = detection?.programName ?? null;
  const detectedNames = candidates.map((c) => c.programName);
  const isMismatch = !detectionLoading && detectedNames.length > 0 && !detectedNames.includes(programName) && nameTouched;

  return (
    <div>
      <div style={{ font: "400 14px/1.55 Inter", color: "var(--rt-fg-2)", marginBottom: 18, maxWidth: 580 }}>
        Choose the folder Studio should use. If it already has{" "}
        <span style={{ color: "var(--rt-teal)", fontFamily: "IBM Plex Mono" }}>.riptide/</span>, Studio opens it.
        Otherwise Riptide creates a small{" "}
        <span style={{ color: "var(--rt-teal)", fontFamily: "IBM Plex Mono" }}>.riptide/</span>{" "}
        setup there.
      </div>

      <div style={{ marginBottom: 22 }}>
        <label style={{ display: "block", font: '500 10px "IBM Plex Mono"', color: "var(--rt-fog-dim)", letterSpacing: "0.08em", marginBottom: 6 }}>
          WORKSPACE FOLDER
        </label>
        <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
          <input
            className="input"
            value={targetPath}
            onChange={(e) => setTargetPath(e.target.value)}
            placeholder="/home/you/code/my-program  or  ~/code/my-program"
            spellCheck={false}
            style={{ minWidth: 0, flex: 1, fontFamily: "IBM Plex Mono" }}
          />
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={onPickFolder}
            disabled={pickingFolder}
            title="Choose workspace folder"
            style={{ justifyContent: "center" }}
          >
            <Icon name={pickingFolder ? "refresh" : "folder"} size={13} />
            {pickingFolder ? "Opening..." : "Browse"}
          </button>
        </div>
        <FolderHint
          error={targetTouched ? targetFolderError : null}
          path={targetPath}
          valid={targetFolderValid}
        />
        {folderPickMessage && (
          <div style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)", marginTop: 6 }}>
            {folderPickMessage}
          </div>
        )}
        {browserOpen && (
          <DirectoryBrowser
            path={browserPath}
            parent={browserParent}
            entries={browserEntries}
            loading={browserLoading}
            error={browserError}
            onClose={onCloseBrowser}
            onRefresh={onRefreshBrowser}
            onNavigate={onNavigateBrowser}
            onUse={onUseBrowserPath}
          />
        )}
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
  onProbingChange: (probing: boolean) => void;
}

function AgentStep({ agents, loading, agentId, setAgentId, model, setModel, onReprobe, onProbingChange }: AgentStepProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probePassed, setProbePassed] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  const recommended = agents.filter((a) => a.recommended);
  const others = agents.filter((a) => !a.recommended);
  const selected = agents.find((a) => a.id === agentId) ?? null;
  const modelChoices = MODEL_OPTIONS[agentId] ?? ["default"];

  useEffect(() => {
    onProbingChange(probing);
    return () => onProbingChange(false);
  }, [probing, onProbingChange]);

  useEffect(() => {
    setProbePassed(false);
    setProbeError(null);
  }, [agentId]);

  async function runProbe() {
    setProbing(true);
    setProbePassed(false);
    setProbeError(null);
    try {
      await onReprobe();
      setProbePassed(true);
    } catch (err) {
      setProbeError((err as Error).message);
    } finally {
      setProbing(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <div style={{
          width: 28, height: 28, borderRadius: 6, background: "var(--rt-slate-2)",
          border: "1px solid var(--rt-slate-line)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0
        }}>
          <Icon name="sparkles" size={14} color="var(--rt-teal)" />
        </div>
        <div>
          <div style={{ font: "600 14px Inter", color: "var(--rt-off-white)" }}>Connect a coding agent</div>
          <div style={{ font: "400 12px Inter", color: "var(--rt-fg-2)", marginTop: 1 }}>
            Studio sends authoring tasks to a local agent CLI.
          </div>
        </div>
      </div>

      {loading ? (
        <ProbingSkeleton />
      ) : (
        <>
          <div style={{ font: '500 10px "IBM Plex Mono"', color: "var(--rt-fog-dim)", letterSpacing: "0.08em", marginBottom: 6 }}>
            AGENT
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 8 }}>
            {recommended.map((a) => (
              <AgentCard key={a.id} agent={a} tagline={AGENT_TAGLINE[a.id] ?? a.label}
                selected={agentId === a.id} onSelect={() => a.detected && setAgentId(a.id)} showRecommended
                iconName={AGENT_ICON[a.id] ?? "sparkles"} />
            ))}
          </div>

          <button type="button" onClick={() => setMoreOpen((v) => !v)}
            style={{
              display: "flex", alignItems: "center", gap: 6, background: "transparent",
              border: "none", color: "var(--rt-fog)", cursor: "pointer", padding: "6px 0", font: "500 12.5px Inter"
            }}>
            <Icon name="chevron" size={11}
              style={{ transition: "transform 120ms", transform: moreOpen ? "rotate(90deg)" : "rotate(0deg)" }} />
            More agents
          </button>

          {moreOpen && others.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 8 }}>
              {others.map((a) => (
                <AgentCard key={a.id} agent={a} tagline={AGENT_TAGLINE[a.id] ?? a.label}
                  selected={agentId === a.id} onSelect={() => a.detected && setAgentId(a.id)}
                  iconName={AGENT_ICON[a.id] ?? "sparkles"} />
              ))}
            </div>
          )}

          <div style={{ font: '500 10px "IBM Plex Mono"', color: "var(--rt-fog-dim)", letterSpacing: "0.08em", margin: "12px 0 5px" }}>
            MODEL
          </div>
          <select className="select" value={model} onChange={(e) => setModel(e.target.value)} style={{ maxWidth: 380 }}>
            {modelChoices.map((m) => (
              <option key={m} value={m}>{MODEL_LABEL[m] ?? m}</option>
            ))}
          </select>

          <div className="card" style={{ marginTop: 14, padding: 12, display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ font: "500 12.5px Inter", color: "var(--rt-off-white)", marginBottom: 2 }}>
                Agent probe
              </div>
              <div style={{ font: "400 11.5px Inter", color: "var(--rt-fg-2)" }}>
                Re-probes for {selected?.label ?? "the selected agent"} and reports its version.
              </div>
            </div>
            <button className="btn btn--ghost btn--sm" onClick={runProbe} disabled={probing}>
              <Icon name={probing ? "refresh" : "cpu"} size={12} />
              {probing ? "Testing..." : "Test now"}
            </button>
          </div>
          {probePassed && (
            <div style={{
              marginTop: 8, padding: "10px 14px", borderRadius: 8,
              background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.35)",
              display: "flex", alignItems: "center", gap: 8,
              font: "500 13px Inter", color: "var(--rt-pass)"
            }}>
              <Icon name="check" size={13} color="var(--rt-pass)" />
              Passed
            </div>
          )}
          {probeError && (
            <div style={{
              marginTop: 8, padding: "10px 14px", borderRadius: 8,
              background: "var(--rt-slate-2)", border: "1px solid var(--rt-slate-line)",
              font: '400 12px "IBM Plex Mono"', color: "var(--rt-fog-dim)"
            }}>{probeError}</div>
          )}
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
  iconName: IconName;
}

function AgentCard({ agent, tagline, selected, onSelect, showRecommended, iconName }: AgentCardProps) {
  const disabled = !agent.detected;
  return (
    <div style={{ position: "relative" }}>
      {showRecommended && agent.detected && (
        <span style={{
          position: "absolute", top: 6, right: 6,
          font: '600 9px "IBM Plex Mono"', letterSpacing: "0.04em",
          background: "rgba(34,197,94,0.16)", color: "var(--rt-pass)",
          border: "1px solid rgba(34,197,94,0.35)", padding: "1px 6px", borderRadius: 999,
          zIndex: 2, whiteSpace: "nowrap"
        }}>Recommended</span>
      )}
      <button onClick={onSelect} disabled={disabled} style={{
        position: "relative", background: "var(--rt-slate-panel)",
        border: selected ? "1px solid var(--rt-teal)" : "1px solid var(--rt-slate-line)",
        boxShadow: selected ? "0 0 0 3px rgba(20,184,182,0.10)" : "none",
        borderRadius: 8, padding: "12px 10px 10px", textAlign: "center",
        cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1,
        display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
        minHeight: 86, width: "100%"
      }}>
      <Icon name={iconName} size={18} color={selected ? "var(--rt-teal)" : "var(--rt-fog)"} />
      <div style={{ font: "600 13px Inter", color: "var(--rt-off-white)" }}>{agent.label}</div>
      <div style={{ font: "400 11px Inter", color: "var(--rt-fog-dim)" }}>{tagline}</div>
      {!agent.detected && (
        <div style={{ font: '400 10px "IBM Plex Mono"', color: "var(--rt-fog-faint)", marginTop: 1 }}>
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
  targetPath: string;
  targetLabel: string;
  programName: string;
  protocol: Protocol;
  protocolLabel: string;
  agent: AgentProbe | null;
  error: string | null;
  existingRiptide: boolean;
}

function LaunchStep({ targetPath, targetLabel, programName, protocol, protocolLabel, agent, error, existingRiptide }: LaunchStepProps) {
  const _ = protocol;
  void _;
  return (
    <div>
      <div style={{ font: "400 14px/1.55 Inter", color: "var(--rt-fg-2)", marginBottom: 22, maxWidth: 580 }}>
        Studio will use the folder below. If{" "}
        <span style={{ color: "var(--rt-teal)", fontFamily: "IBM Plex Mono" }}>.riptide/</span>{" "}
        already exists there, Studio opens it. Otherwise Riptide creates a small setup folder.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 18 }}>
        <div className="card" style={{ padding: 18 }}>
          <Kicker style={{ marginBottom: 8 }}>WORKSPACE</Kicker>
          <div style={{ font: "500 16px Inter", color: "var(--rt-off-white)", marginBottom: 4 }}>{programName}</div>
          <div style={{ font: '400 12px "IBM Plex Mono"', color: "var(--rt-fog-dim)" }}>
            {targetLabel}
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
        <Kicker style={{ marginBottom: 8 }}>WILL USE</Kicker>
        <div className="code" style={{ background: "transparent", border: "none", padding: 0 }}>
{`${targetPath.replace(/\/+$/g, "")}/.riptide
  opened if present
  created if missing`}
        </div>
      </div>
      {error && (
        <div className="card" style={{ padding: 14, border: "1px solid rgba(239,68,68,0.35)", background: "rgba(239,68,68,0.06)" }}>
          <Kicker style={{ marginBottom: 6, color: "var(--rt-fail)" }}>{existingRiptide ? "SAVE FAILED" : "SETUP FAILED"}</Kicker>
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
  const busyLabel = "Adding…";
  const submitLabel = "Add workspace";
  return (
    <div style={{ padding: "14px 24px", borderTop: "1px solid var(--rt-slate-line)", display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-faint)" }}>
        {submitting && busyLabel}
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
          {submitting ? busyLabel : submitLabel}
        </button>
      )}
    </div>
  );
}

function defaultProgramName(workspace: StudioWorkspace): string {
  const base = workspace.path.split("/").filter(Boolean).pop() ?? "my-program";
  const slug = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (PROGRAM_NAME_RE.test(slug)) return slug;
  return "my-program";
}
