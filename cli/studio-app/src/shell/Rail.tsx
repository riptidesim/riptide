import type { StudioWorkspace } from "../api";
import { Icon } from "../ui/Icon";
import { workspaceColor, workspaceInitials } from "./types";

interface RailProps {
  workspaces: StudioWorkspace[];
  activeIdx: number;
  setActiveIdx: (idx: number) => void;
  onAddWorkspace: () => void;
}

export function WorkspaceRail({ workspaces, activeIdx, setActiveIdx, onAddWorkspace }: RailProps) {
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
            title={w.label}
            onClick={() => setActiveIdx(i)}
          >
            {workspaceInitials(w.label)}
            {hasWarnings && <span className="dot" />}
          </button>
        );
      })}
      <button className="rail__add" title="Add workspace" onClick={onAddWorkspace}>
        <Icon name="plus" size={14} />
      </button>
    </div>
  );
}
