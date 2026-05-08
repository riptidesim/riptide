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

export const NAV: NavEntry[] = [
  { kind: "item", id: "overview", label: "Overview", icon: "home" },
  { kind: "item", id: "handoff", label: "Agent chat", icon: "chat" },
  { kind: "item", id: "adapter", label: "Adapter", icon: "plug" },
  { kind: "group", id: "work", label: "WORK" },
  { kind: "item", id: "campaigns", label: "Campaigns", icon: "rocket" },
  { kind: "item", id: "library", label: "Library", icon: "library" },
  { kind: "group", id: "evidence", label: "EVIDENCE" },
  { kind: "item", id: "jobs", label: "Job queue", icon: "listTodo" },
  { kind: "item", id: "reports", label: "Reports", icon: "fileText" },
  { kind: "group", id: "help", label: "HELP" },
  { kind: "item", id: "tutorial", label: "Tutorial", icon: "compass" }
];

export function workspaceInitials(label: string): string {
  const parts = label.split(/[-_\s]+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

export function workspaceColor(id: string, source: "current" | "case-study" | "registered"): string {
  if (source === "current") return "#14B8B6";
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  const palette = source === "registered"
    ? ["#1E5F7E", "#3F6F7A", "#5B7A8B", "#256C68", "#3A6B5C"]
    : ["#0E8A88", "#7A8A99", "#2A3B4E", "#3F6F7A", "#5B7A8B"];
  return palette[Math.abs(h) % palette.length]!;
}
