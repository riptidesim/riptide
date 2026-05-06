import { useEffect, useRef, useState } from "react";

import { Icon } from "../ui/Icon";
import { AGENT_ADAPTERS } from "./types";

interface AdapterChipProps {
  onConfigure: () => void;
}

export function AdapterChip({ onConfigure }: AdapterChipProps) {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState("cc");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const active = AGENT_ADAPTERS.find((a) => a.id === activeId)!;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button onClick={() => setOpen((o) => !o)} className="adapter-chip">
        <span className={`dot dot--${active.dot}`} />
        <span className="adapter-chip__label">{active.label}</span>
        <span className="adapter-chip__meta">· local</span>
        <Icon name="chevronDown" size={11} color="var(--rt-fog-dim)" />
      </button>
      {open && (
        <div className="adapter-pop">
          <div className="adapter-pop__head">SWITCH ADAPTER</div>
          {AGENT_ADAPTERS.map((a) => (
            <button
              key={a.id}
              className={`adapter-pop__row${a.id === activeId ? " adapter-pop__row--active" : ""}`}
              disabled={a.dot === "fail"}
              onClick={() => {
                setActiveId(a.id);
                setOpen(false);
              }}
            >
              <span className={`dot dot--${a.dot}`} />
              <span style={{ flex: 1 }}>{a.label}</span>
              <span className="adapter-pop__meta">{a.detail}</span>
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
            <span style={{ flex: 1 }}>Configure adapters…</span>
            <Icon name="chevron" size={11} color="var(--rt-fog-dim)" />
          </button>
        </div>
      )}
    </div>
  );
}
