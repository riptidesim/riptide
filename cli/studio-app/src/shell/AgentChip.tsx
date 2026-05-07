import { useEffect, useRef, useState } from "react";

import type { AgentProbe } from "../api";
import type { AgentPreference } from "../agentMeta";
import { Icon } from "../ui/Icon";

interface AgentChipProps {
  agents: AgentProbe[];
  pref: AgentPreference | null;
  setPref: (next: AgentPreference) => void;
  onConfigure: () => void;
}

type Dot = "pass" | "queued" | "fail";

function dotFor(agent: AgentProbe): Dot {
  return agent.detected ? "pass" : "fail";
}

export function AgentChip({ agents, pref, setPref, onConfigure }: AgentChipProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const activeId = pref?.agentId ?? null;
  const active = activeId ? agents.find((a) => a.id === activeId) ?? null : null;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button onClick={() => setOpen((o) => !o)} className="adapter-chip">
        {active ? (
          <>
            <span className={`dot dot--${dotFor(active)}`} />
            <span className="adapter-chip__label">{active.label}</span>
          </>
        ) : (
          <>
            <span className="dot dot--fail" />
            <span className="adapter-chip__label">No agent connected</span>
          </>
        )}
        <Icon name="chevronDown" size={11} color="var(--rt-fog-dim)" />
      </button>
      {open && (
        <div className="adapter-pop">
          <div className="adapter-pop__head">SWITCH AGENT</div>
          {agents.length === 0 && (
            <div className="adapter-pop__row" style={{ cursor: "default" }}>
              <span className="adapter-pop__meta">probing…</span>
            </div>
          )}
          {agents.map((a) => (
            <button
              key={a.id}
              className={`adapter-pop__row${a.id === activeId ? " adapter-pop__row--active" : ""}`}
              disabled={!a.detected}
              onClick={() => {
                setPref({ agentId: a.id, model: pref?.agentId === a.id ? pref.model : "default" });
                setOpen(false);
              }}
            >
              <span className={`dot dot--${dotFor(a)}`} />
              <span style={{ flex: 1 }}>{a.label}</span>
              {!a.detected && <span className="adapter-pop__meta">not detected</span>}
              {a.id === activeId && <Icon name="check" size={12} color="var(--rt-teal)" />}
            </button>
          ))}
          <div className="adapter-pop__divider" />
          <button
            className="adapter-pop__row"
            onClick={() => {
              setOpen(false);
              onConfigure();
            }}
          >
            <Icon name="settings" size={12} color="var(--rt-fog-dim)" />
            <span style={{ flex: 1 }}>Configure agents…</span>
            <Icon name="chevron" size={11} color="var(--rt-fog-dim)" />
          </button>
        </div>
      )}
    </div>
  );
}
