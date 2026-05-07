import type { PageId } from "./types";

export const DEFAULT_PAGE: PageId = "overview";

const PAGE_IDS = new Set<string>([
  "overview",
  "handoff",
  "adapter",
  "campaigns",
  "library",
  "jobs",
  "reports",
  "tutorial",
  "settings"
]);

type HistoryMode = "push" | "replace";

interface LocationOptions {
  artifactId?: string | null;
}

export function readStudioPage(): PageId {
  if (!hasWindow()) return DEFAULT_PAGE;
  const page = new URLSearchParams(window.location.search).get("page");
  return isPageId(page) ? page : DEFAULT_PAGE;
}

export function readStudioWorkspace(): string | null {
  if (!hasWindow()) return null;
  return new URLSearchParams(window.location.search).get("workspace");
}

export function readStudioArtifact(): string | null {
  if (!hasWindow()) return null;
  return new URLSearchParams(window.location.search).get("artifact");
}

export function writeStudioLocation(
  page: PageId,
  workspaceId: string | null,
  mode: HistoryMode,
  options: LocationOptions = {}
): void {
  if (!hasWindow()) return;

  const url = new URL(window.location.href);
  if (page === DEFAULT_PAGE) url.searchParams.delete("page");
  else url.searchParams.set("page", page);

  if (workspaceId) url.searchParams.set("workspace", workspaceId);
  else url.searchParams.delete("workspace");

  if (page !== "reports") url.searchParams.delete("artifact");
  if ("artifactId" in options) {
    if (options.artifactId) url.searchParams.set("artifact", options.artifactId);
    else url.searchParams.delete("artifact");
  }

  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return;

  if (mode === "replace") window.history.replaceState({ page, workspaceId }, "", next);
  else window.history.pushState({ page, workspaceId }, "", next);
}

function isPageId(value: string | null): value is PageId {
  return value !== null && PAGE_IDS.has(value);
}

function hasWindow(): boolean {
  return typeof window !== "undefined" && typeof window.location !== "undefined";
}
