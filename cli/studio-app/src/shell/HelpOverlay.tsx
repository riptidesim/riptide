import { useEffect } from "react";

interface HelpOverlayProps {
  open: boolean;
  onClose: () => void;
}

interface ShortcutRow {
  keys: string[];
  label: string;
}

export function HelpOverlay({ open, onClose }: HelpOverlayProps) {
  const isMac = typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");
  const cmd = isMac ? "⌘" : "Ctrl";

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const rows: ShortcutRow[] = [
    { keys: [cmd, "K"], label: "Open command palette" },
    { keys: ["/"], label: "Open command palette" },
    { keys: ["?"], label: "Show this shortcut help" },
    { keys: ["Esc"], label: "Close palette / overlay" },
    { keys: ["↑", "↓"], label: "Navigate palette results" },
    { keys: ["Enter"], label: "Open selected palette result" }
  ];

  return (
    <div className="cmdk" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div className="cmdk__backdrop" onClick={onClose} />
      <div className="cmdk__panel" role="document" style={{ width: "min(420px, 100%)" }}>
        <div className="cmdk__field" style={{ justifyContent: "space-between" }}>
          <span style={{ font: '500 13px "IBM Plex Mono"', letterSpacing: ".12em", textTransform: "uppercase", color: "var(--rt-fog)" }}>
            Keyboard shortcuts
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ background: "transparent", border: 0, color: "var(--rt-fog-dim)", cursor: "pointer", font: "400 12px Inter" }}
          >
            Esc
          </button>
        </div>
        <div className="cmdk__results" style={{ padding: "8px 4px" }}>
          {rows.map((row) => (
            <div
              key={row.label}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 16,
                padding: "8px 16px",
                font: "400 13px Inter",
                color: "var(--rt-off-white)"
              }}
            >
              <span>{row.label}</span>
              <span style={{ display: "inline-flex", gap: 4 }}>
                {row.keys.map((key, idx) => (
                  <kbd
                    key={`${row.label}-${idx}`}
                    style={{
                      display: "inline-block",
                      background: "var(--rt-slate-2)",
                      border: "1px solid var(--rt-slate-line)",
                      borderRadius: 4,
                      color: "var(--rt-fog)",
                      font: '500 11px/1 "IBM Plex Mono", monospace',
                      padding: "4px 6px",
                      minWidth: 18,
                      textAlign: "center"
                    }}
                  >
                    {key}
                  </kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
