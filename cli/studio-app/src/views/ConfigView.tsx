import { useEffect, useState } from "react";

import {
  api,
  type ArtifactIndex,
  type ConfigIntentInput,
  type ConfigIntentResponse,
  type Workspace
} from "../api";

interface Props {
  workspace: Workspace;
  artifacts: ArtifactIndex | null;
}

const PROTOCOL_CLASSES = [
  "lending",
  "amm",
  "perps",
  "vault",
  "stablecoin",
  "yield",
  "bridge",
  "other"
];

const RISK_GOALS = [
  "no_bad_debt",
  "no_solvency_failure",
  "no_oracle_drift",
  "no_value_loss",
  "no_unauthorized_pause",
  "custom"
];

const EVIDENCE_BOUNDARIES = [
  "current-state-only",
  "current-state-plus-replay",
  "campaign-grid",
  "guided-sim",
  "case-study"
];

export function ConfigView({ workspace, artifacts }: Props) {
  const [protocolClass, setProtocolClass] = useState("lending");
  const [repoPath, setRepoPath] = useState(workspace.path);
  const [riskGoal, setRiskGoal] = useState("no_bad_debt");
  const [scenarioTarget, setScenarioTarget] = useState("");
  const [evidenceBoundary, setEvidenceBoundary] = useState("current-state-only");
  const [notes, setNotes] = useState("");
  const [intent, setIntent] = useState<ConfigIntentResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Reset path when workspace changes.
  useEffect(() => {
    setRepoPath(workspace.path);
    const adapter = artifacts?.artifacts.find((a) => a.kind === "adapter");
    const adapterClass = typeof adapter?.meta?.protocol_class === "string" ? adapter.meta.protocol_class : null;
    if (adapterClass && PROTOCOL_CLASSES.includes(adapterClass)) {
      setProtocolClass(adapterClass);
    }
  }, [workspace.id, workspace.path, artifacts]);

  async function handleGenerate(ev: React.FormEvent) {
    ev.preventDefault();
    setSubmitting(true);
    setError(null);
    setCopied(false);
    const payload: ConfigIntentInput = {
      workspace_id: workspace.id,
      protocol_class: protocolClass,
      repo_path: repoPath.trim(),
      risk_goal: riskGoal.trim(),
      scenario_target: scenarioTarget.trim(),
      evidence_boundary: evidenceBoundary.trim(),
      notes: notes.trim()
    };
    try {
      const res = await api.configIntent(payload);
      setIntent(res);
    } catch (err) {
      setIntent(null);
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCopy() {
    if (!intent) return;
    try {
      await navigator.clipboard.writeText(intent.handoff_prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable; surface a hint
      setError("clipboard unavailable; select and copy the text manually");
    }
  }

  return (
    <>
      <div className="rt-page-kicker">CONFIG HANDOFF</div>
      <h1>Configure a Riptide workspace</h1>
      <p>
        This panel produces a structured config intent and a copyable{" "}
        <code className="rt-code-inline">riptide-config</code> prompt. Studio does not silently
        invoke an agent or mutate files — proposed file targets and validation commands are shown
        for human approval first.
      </p>

      <div className="rt-chat-grid">
        <form className="rt-card" onSubmit={handleGenerate}>
          <h3>Configuration intent</h3>

          <div className="rt-form-row">
            <label htmlFor="cfg-protocol-class">Protocol class</label>
            <select
              id="cfg-protocol-class"
              className="rt-select"
              value={protocolClass}
              onChange={(e) => setProtocolClass(e.target.value)}
            >
              {PROTOCOL_CLASSES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          <div className="rt-form-row">
            <label htmlFor="cfg-repo-path">Repository path</label>
            <input
              id="cfg-repo-path"
              className="rt-input"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="/abs/path/to/your/program"
              required
            />
          </div>

          <div className="rt-form-row">
            <label htmlFor="cfg-risk-goal">Risk goal</label>
            <select
              id="cfg-risk-goal"
              className="rt-select"
              value={riskGoal}
              onChange={(e) => setRiskGoal(e.target.value)}
            >
              {RISK_GOALS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          <div className="rt-form-row">
            <label htmlFor="cfg-scenario-target">Scenario / campaign target</label>
            <input
              id="cfg-scenario-target"
              className="rt-input"
              value={scenarioTarget}
              onChange={(e) => setScenarioTarget(e.target.value)}
              placeholder="whale-shock, oracle-drift-grid, ..."
            />
          </div>

          <div className="rt-form-row">
            <label htmlFor="cfg-evidence">Evidence boundary</label>
            <select
              id="cfg-evidence"
              className="rt-select"
              value={evidenceBoundary}
              onChange={(e) => setEvidenceBoundary(e.target.value)}
            >
              {EVIDENCE_BOUNDARIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          <div className="rt-form-row">
            <label htmlFor="cfg-notes">Notes for the agent (optional)</label>
            <textarea
              id="cfg-notes"
              className="rt-textarea"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Operator context the agent should not have to guess."
            />
          </div>

          <div style={{ display: "flex", gap: 8 }}>
            <button className="rt-btn rt-btn--accent" type="submit" disabled={submitting}>
              {submitting ? "Generating…" : "Generate handoff"}
            </button>
            {error ? <span className="rt-meta" style={{ color: "var(--rt-fail)" }}>{error}</span> : null}
          </div>
        </form>

        <div>
          <div className="rt-card">
            <h3>Generated handoff</h3>
            <p className="rt-meta">
              The prompt below is intended for the <code className="rt-code-inline">riptide-config</code>{" "}
              skill. Studio does not run it for you.
            </p>
            <pre className="rt-chat-log">
              {intent?.handoff_prompt ?? "Submit the form to generate the prompt."}
            </pre>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="rt-btn" type="button" onClick={handleCopy} disabled={!intent}>
                {copied ? "Copied" : "Copy prompt"}
              </button>
            </div>
          </div>

          {intent ? (
            <>
              <div className="rt-card">
                <h3>Intent (config-intent.json)</h3>
                <pre className="rt-code-block">{JSON.stringify(intent.intent, null, 2)}</pre>
              </div>
              <div className="rt-card">
                <h3>Proposed file targets</h3>
                <ul>
                  {intent.proposed_files.map((f) => (
                    <li key={f.path}>
                      <code className="rt-code-inline">{f.path}</code> — {f.purpose}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rt-card">
                <h3>Suggested validation commands</h3>
                <pre className="rt-code-block">{intent.validation_commands.join("\n")}</pre>
              </div>
              {intent.notes.length > 0 ? (
                <div className="rt-card">
                  <h3>Notes</h3>
                  <ul>
                    {intent.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
