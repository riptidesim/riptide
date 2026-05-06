import type { IconName } from "../ui/Icon";

export type PageId =
  | "overview"
  | "handoff"
  | "adapter"
  | "campaigns"
  | "library"
  | "jobs"
  | "reports"
  | "tutorial"
  | "settings";

export interface Workspace {
  id: string;
  label: string;
  name: string;
  color: string;
  notif: boolean;
}

export interface NavGroup {
  kind: "group";
  id: string;
  label: string;
}

export interface NavItem {
  kind: "item";
  id: PageId;
  label: string;
  icon: IconName;
  badge?: number;
  badgeAccent?: boolean;
}

export type NavEntry = NavGroup | NavItem;

export const WORKSPACES: Workspace[] = [
  { id: "lend", label: "LF", name: "lending-fund", color: "#14B8B6", notif: false },
  { id: "perp", label: "PX", name: "perp-x", color: "#7A8A99", notif: true },
  { id: "amm", label: "KS", name: "kelp-swap", color: "#0E8A88", notif: false },
  { id: "lst", label: "TS", name: "tide-stake", color: "#2A3B4E", notif: false }
];

export const NAV: NavEntry[] = [
  { kind: "item", id: "overview", label: "Overview", icon: "home" },
  { kind: "item", id: "handoff", label: "Config handoff", icon: "handoff" },
  { kind: "item", id: "adapter", label: "Adapter", icon: "cpu" },
  { kind: "group", id: "work", label: "WORK" },
  { kind: "item", id: "campaigns", label: "Campaigns", icon: "flame", badge: 6 },
  { kind: "item", id: "library", label: "Library", icon: "book" },
  { kind: "group", id: "evidence", label: "EVIDENCE" },
  { kind: "item", id: "jobs", label: "Job queue", icon: "queue", badge: 3, badgeAccent: true },
  { kind: "item", id: "reports", label: "Reports", icon: "file", badge: 6 },
  { kind: "group", id: "help", label: "HELP" },
  { kind: "item", id: "tutorial", label: "Tutorial", icon: "book" }
];

export interface AgentAdapter {
  id: string;
  label: string;
  detail: string;
  dot: "pass" | "queued" | "fail";
}

export const AGENT_ADAPTERS: AgentAdapter[] = [
  { id: "cc", label: "Claude Code", detail: "local · v0.18.2", dot: "pass" },
  { id: "cdx", label: "Codex", detail: "local · v1.4.0", dot: "pass" },
  { id: "gem", label: "Gemini CLI", detail: "local · v0.9.1", dot: "queued" },
  { id: "cur", label: "Cursor", detail: "not detected", dot: "fail" },
  { id: "oc", label: "OpenCode", detail: "not detected", dot: "fail" }
];
