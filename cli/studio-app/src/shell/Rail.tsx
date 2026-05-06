import { Icon } from "../ui/Icon";
import { WORKSPACES } from "./types";

interface RailProps {
  activeIdx: number;
  setActiveIdx: (idx: number) => void;
}

export function WorkspaceRail({ activeIdx, setActiveIdx }: RailProps) {
  return (
    <div className="rail">
      <div className="rail__brand" title="Riptide Studio">
        <img src="assets/logo-icon.png" alt="Riptide" />
      </div>
      <div className="rail__divider" />
      {WORKSPACES.map((w, i) => (
        <button
          key={w.id}
          className={`rail__avatar${i === activeIdx ? " rail__avatar--active" : ""}`}
          style={{ background: w.color, color: i === activeIdx ? "#042023" : "#E6EEF2" }}
          title={w.name}
          onClick={() => setActiveIdx(i)}
        >
          {w.label}
          {w.notif && <span className="dot" />}
        </button>
      ))}
      <button className="rail__add" title="Add workspace">
        <Icon name="plus" size={14} />
      </button>
    </div>
  );
}
