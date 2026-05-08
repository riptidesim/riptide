import { useState } from "react";

import type { StudioWorkspace } from "../api";
import { Icon } from "../ui/Icon";
import { workspaceColor, workspaceInitials } from "./types";

interface RailProps {
  workspaces: StudioWorkspace[];
  activeIdx: number;
  setActiveIdx: (idx: number) => void;
  onAddWorkspace: () => void;
}

interface TipState {
  label: string;
  top: number;
  left: number;
}

export function WorkspaceRail({ workspaces, activeIdx, setActiveIdx, onAddWorkspace }: RailProps) {
  const [tip, setTip] = useState<TipState | null>(null);

  function showTip(label: string, target: HTMLElement) {
    const rect = target.getBoundingClientRect();
    setTip({ label, top: rect.top + rect.height / 2, left: rect.right + 10 });
  }

  return (
    <div className="rail">
      <div className="rail__brand" title="Riptide Studio">
        <img src="assets/logo-icon.png" alt="Riptide" />
      </div>
      <div className="rail__divider" />
      {workspaces.map((w, i) => {
        const active = i === activeIdx;
        const color = workspaceColor(w.id, w.source);
        const hasWarnings = w.warnings.length > 0;
        return (
          <button
            key={w.id}
            className={`rail__avatar${active ? " rail__avatar--active" : ""}`}
            style={{ background: color, color: active ? "#042023" : "#E6EEF2" }}
            aria-label={w.label}
            onMouseEnter={(e) => showTip(w.label, e.currentTarget)}
            onMouseLeave={() => setTip(null)}
            onFocus={(e) => showTip(w.label, e.currentTarget)}
            onBlur={() => setTip(null)}
            onClick={() => setActiveIdx(i)}
          >
            {workspaceInitials(w.label)}
            {hasWarnings && <span className="dot" />}
          </button>
        );
      })}
      <button
        className="rail__add"
        aria-label="Add workspace"
        onMouseEnter={(e) => showTip("Add workspace", e.currentTarget)}
        onMouseLeave={() => setTip(null)}
        onFocus={(e) => showTip("Add workspace", e.currentTarget)}
        onBlur={() => setTip(null)}
        onClick={onAddWorkspace}
      >
        <Icon name="plus" size={14} />
      </button>
      {tip && (
        <div
          className="rail__tooltip"
          style={{ top: tip.top, left: tip.left }}
          role="tooltip"
        >
          {tip.label}
        </div>
      )}
    </div>
  );
}
