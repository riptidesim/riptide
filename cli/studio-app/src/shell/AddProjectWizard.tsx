import { useEffect, useMemo, useState } from "react";

import {
  api,
  ApiError,
  type Protocol,
  type ProtocolChoice,
  type StudioWorkspace
} from "../api";
import { Icon } from "../ui/Icon";
import { Kicker } from "../ui/primitives";

interface AddProjectWizardProps {
  onClose: () => void;
  onCreated: (workspaces: StudioWorkspace[], newWorkspaceId: string | null) => void;
}

const PROGRAM_NAME_RE = /^[a-z][a-z0-9-]*$/;

export function AddProjectWizard({ onClose, onCreated }: AddProjectWizardProps) {
  const [folderPath, setFolderPath] = useState<string>("");
  const [folderTouched, setFolderTouched] = useState(false);
  const [programName, setProgramName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [protocol, setProtocol] = useState<Protocol>("custom");
  const [protocols, setProtocols] = useState<ProtocolChoice[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [folderPickMessage, setFolderPickMessage] = useState<string | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserPath, setBrowserPath] = useState("");
  const [browserEntries, setBrowserEntries] = useState<Array<{ name: string; path: string }>>([]);
  const [browserParent, setBrowserParent] = useState<string | null>(null);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    api.protocols().then((res) => setProtocols(res.protocols)).catch(() => {});
  }, []);

  const folderError = useMemo(() => folderValidationError(folderPath), [folderPath]);
  const folderValid = folderError === null && folderPath.trim().length > 0;
  const derivedName = useMemo(() => deriveProgramName(folderPath), [folderPath]);
  const effectiveName = nameTouched ? programName : derivedName;
  const programNameValid = PROGRAM_NAME_RE.test(effectiveName);
  const canSubmit = folderValid && programNameValid && protocol.length > 0 && !submitting && !pickingFolder;

  function close() {
    if (submitting) return;
    onClose();
  }

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const trimmed = folderPath.trim();
      const res = await api.init({
        programName: effectiveName,
        protocol,
        path: trimmed,
        label: basename(trimmed)
      });
      const newest = res.workspaces.find((w) => samePath(w.path, trimmed)) ?? null;
      onCreated(res.workspaces, newest?.id ?? null);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : (err as Error).message);
      setSubmitting(false);
    }
  }

  async function pickFolder() {
    if (submitting || pickingFolder) return;
    setPickingFolder(true);
    setFolderPickMessage(null);
    try {
      // Try the OS-native folder picker first (osascript / PowerShell /
      // zenity / kdialog / yad). Only fall back to the in-app browser
      // when the native picker is unavailable — e.g. headless Linux,
      // SSH session with no DISPLAY, or none of the GUI helpers
      // installed.
      const native = await api.pickDirectory();
      if (native.cancelled) {
        // User dismissed the dialog; do nothing, leave the field as-is.
        return;
      }
      if (native.path) {
        setFolderPath(native.path);
        setFolderTouched(true);
        setFolderPickMessage("selected via OS folder picker");
        return;
      }
      // Native picker unavailable — open the in-app browser as fallback.
      if (native.message) {
        setFolderPickMessage(native.message);
      }
      setBrowserOpen(true);
      await loadBrowserDirectory(folderValid ? folderPath.trim() : undefined);
    } catch (err) {
      // Network / API blew up — fall back to the in-app browser too,
      // since the user still needs a way to choose a folder.
      setFolderPickMessage((err as Error).message);
      setBrowserOpen(true);
      try {
        await loadBrowserDirectory(folderValid ? folderPath.trim() : undefined);
      } catch {
        // browser load also failed; the existing error UI in
        // DirectoryBrowser will show its own diagnostic.
      }
    } finally {
      setPickingFolder(false);
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

  function useBrowserPath() {
    if (!browserPath) return;
    setFolderPath(browserPath);
    setFolderTouched(true);
    setFolderPickMessage("selected from workspace browser");
    setBrowserOpen(false);
  }

  return (
    <div className="scrim" onClick={close}>
      <div className="modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: "18px 24px", borderBottom: "1px solid var(--rt-slate-line)", display: "flex", alignItems: "center", gap: 12 }}>
          <img src="assets/logo-icon.png" style={{ width: 24, height: 24 }} alt="Riptide" />
          <div style={{ flex: 1 }}>
            <Kicker>NEW PROJECT</Kicker>
            <div style={{ font: "600 16px Inter", color: "var(--rt-off-white)", marginTop: 4 }}>
              Bootstrap a Riptide workspace
            </div>
          </div>
          <button
            className="btn btn--quiet btn--sm"
            onClick={close}
            disabled={submitting}
            title="Close"
            style={{ padding: 6 }}
          >
            <Icon name="x" size={12} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
          <div style={{ font: "400 14px/1.55 Inter", color: "var(--rt-fg-2)", marginBottom: 18, maxWidth: 580 }}>
            Pick a folder for the new workspace. Riptide writes a thin{" "}
            <span style={{ color: "var(--rt-teal)", fontFamily: "IBM Plex Mono" }}>.riptide/</span>{" "}
            scaffold inside that directory and saves a reference so it shows up in your sidebar next time.
          </div>

          <div style={{ marginBottom: 22 }}>
            <label style={{ display: "block", font: '500 10px "IBM Plex Mono"', color: "var(--rt-fog-dim)", letterSpacing: "0.08em", marginBottom: 6 }}>
              WORKSPACE FOLDER
            </label>
            <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
              <input
                className="input"
                value={folderPath}
                onChange={(e) => {
                  setFolderPath(e.target.value);
                  setFolderTouched(true);
                  setFolderPickMessage(null);
                }}
                placeholder="/Users/you/code/my-program  or  ~/code/my-program"
                spellCheck={false}
                autoFocus
                style={{ minWidth: 0, flex: 1, fontFamily: "IBM Plex Mono" }}
              />
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void pickFolder()}
                disabled={submitting || pickingFolder}
                title="Choose workspace folder"
                style={{ justifyContent: "center" }}
              >
                <Icon name={pickingFolder ? "refresh" : "folder"} size={13} />
                {pickingFolder ? "Opening..." : "Browse"}
              </button>
            </div>
            <FolderHint
              error={folderTouched ? folderError : null}
              path={folderPath}
              valid={folderValid}
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
                onClose={() => setBrowserOpen(false)}
                onRefresh={() => void loadBrowserDirectory(browserPath)}
                onNavigate={(next) => void loadBrowserDirectory(next)}
                onUse={useBrowserPath}
              />
            )}
          </div>

          <div style={{ marginBottom: 22 }}>
            <label style={{ display: "block", font: '500 10px "IBM Plex Mono"', color: "var(--rt-fog-dim)", letterSpacing: "0.08em", marginBottom: 6 }}>
              PROGRAM NAME
            </label>
            <input
              className="input"
              value={effectiveName}
              onChange={(e) => { setProgramName(e.target.value); setNameTouched(true); }}
              placeholder="my-program"
              style={{ width: "100%", maxWidth: 380, fontFamily: "IBM Plex Mono" }}
            />
            <ProgramNameHint
              valid={programNameValid}
              derivedFromPath={!nameTouched && folderPath.trim().length > 0}
            />
          </div>

          <div>
            <label style={{ display: "block", font: '500 10px "IBM Plex Mono"', color: "var(--rt-fog-dim)", letterSpacing: "0.08em", marginBottom: 6 }}>
              PROTOCOL CLASS
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
              {protocols.map((p) => (
                <button
                  key={p.value}
                  type="button"
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

          {submitError && (
            <div className="card" style={{
              marginTop: 18, padding: 14,
              border: "1px solid rgba(239,68,68,0.35)", background: "rgba(239,68,68,0.06)"
            }}>
              <Kicker style={{ marginBottom: 6, color: "var(--rt-fail)" }}>BOOTSTRAP FAILED</Kicker>
              <div style={{ font: '400 12.5px "IBM Plex Mono"', color: "var(--rt-fail)" }}>{submitError}</div>
            </div>
          )}
        </div>

        <div style={{ padding: "14px 24px", borderTop: "1px solid var(--rt-slate-line)", display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1, font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-faint)" }}>
            {submitting && "Bootstrapping…"}
          </div>
          {!submitting && (
            <button className="btn btn--ghost btn--sm" onClick={close}>Cancel</button>
          )}
          <button className="btn btn--primary btn--sm" onClick={submit} disabled={!canSubmit}>
            {submitting ? <Icon name="refresh" size={13} /> : <Icon name="play" size={13} />}
            {submitting ? "Bootstrapping…" : "Create project"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DirectoryBrowser({
  path,
  parent,
  entries,
  loading,
  error,
  onClose,
  onRefresh,
  onNavigate,
  onUse
}: {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; path: string }>;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onNavigate: (path: string) => void;
  onUse: () => void;
}) {
  return (
    <div
      className="card"
      style={{
        marginTop: 10,
        padding: 0,
        overflow: "hidden",
        borderRadius: 8
      }}
    >
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--rt-slate-line)", display: "flex", alignItems: "center", gap: 8 }}>
        <Icon name="folder" size={14} color="var(--rt-teal)" />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ font: '500 10px "IBM Plex Mono"', letterSpacing: "0.08em", color: "var(--rt-fog-dim)", marginBottom: 3 }}>
            BROWSE FOLDERS
          </div>
          <div style={{ font: '400 12px "IBM Plex Mono"', color: "var(--rt-off-white)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {path || "Loading..."}
          </div>
        </div>
        <button type="button" className="btn btn--quiet btn--sm" onClick={onRefresh} disabled={loading} title="Refresh folder list" style={{ padding: 6 }}>
          <Icon name="refresh" size={12} />
        </button>
        <button type="button" className="btn btn--quiet btn--sm" onClick={onClose} title="Close folder browser" style={{ padding: 6 }}>
          <Icon name="x" size={12} />
        </button>
      </div>

      <div style={{ padding: 10 }}>
        {error ? (
          <div style={{ font: '400 11.5px "IBM Plex Mono"', color: "var(--rt-fail)", padding: "8px 2px" }}>{error}</div>
        ) : loading ? (
          <div style={{ font: '400 11.5px "IBM Plex Mono"', color: "var(--rt-fog-dim)", padding: "8px 2px" }}>Loading folders...</div>
        ) : (
          <div style={{ maxHeight: 220, overflowY: "auto", display: "grid", gap: 4 }}>
            {parent && (
              <button type="button" className="folder-row" onClick={() => onNavigate(parent)}>
                <Icon name="chevron" size={12} />
                <span>..</span>
                <span>{parent}</span>
              </button>
            )}
            {entries.length === 0 && (
              <div style={{ font: '400 11.5px "IBM Plex Mono"', color: "var(--rt-fog-dim)", padding: "8px 2px" }}>No child folders</div>
            )}
            {entries.map((entry) => (
              <button key={entry.path} type="button" className="folder-row" onClick={() => onNavigate(entry.path)}>
                <Icon name="folder" size={12} />
                <span>{entry.name}</span>
                <span>{entry.path}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={{ padding: "10px 12px", borderTop: "1px solid var(--rt-slate-line)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn--primary btn--sm" onClick={onUse} disabled={!path || loading}>
          <Icon name="check" size={13} />
          Use this folder
        </button>
      </div>
    </div>
  );
}

function FolderHint({ error, path, valid }: { error: string | null; path: string; valid: boolean }) {
  if (error) {
    return <div style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fail)", marginTop: 6 }}>{error}</div>;
  }
  if (path.trim().length === 0) {
    return <div style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)", marginTop: 6 }}>
      paste an absolute path or use ~ for your home directory
    </div>;
  }
  if (valid) {
    return <div style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-teal)", marginTop: 6 }}>
      ✓ folder will be created if it doesn't exist
    </div>;
  }
  return null;
}

function ProgramNameHint({ valid, derivedFromPath }: { valid: boolean; derivedFromPath: boolean }) {
  if (!valid) {
    return <div style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fail)", marginTop: 6 }}>
      lowercase letters, numbers, dashes; must start with a letter
    </div>;
  }
  if (derivedFromPath) {
    return <div style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)", marginTop: 6 }}>
      derived from the folder name — edit if needed
    </div>;
  }
  return null;
}

function folderValidationError(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!trimmed.startsWith("/") && !trimmed.startsWith("~")) {
    return "use an absolute path (must start with / or ~)";
  }
  return null;
}

function deriveProgramName(folderPath: string): string {
  const base = basename(folderPath.trim());
  if (base.length === 0) return "";
  const slug = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug;
}

function basename(p: string): string {
  const trimmed = p.replace(/[/\\]+$/g, "");
  const segs = trimmed.split(/[/\\]/);
  return segs[segs.length - 1] ?? "";
}

function samePath(a: string, b: string): boolean {
  const trim = (v: string) => v.replace(/\/+$/g, "");
  if (trim(a) === trim(b)) return true;
  if (b.startsWith("~/")) {
    return trim(a).endsWith(trim(b.slice(1)));
  }
  return false;
}
