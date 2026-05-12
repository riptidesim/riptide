import { useEffect, useMemo, useState } from "react";

import { App as StudioApp } from "../../cli/studio-app/src/App";
import { Icon } from "../../cli/studio-app/src/ui/Icon";
import { DemoEventSource, demoStore, type DemoSnapshot } from "./studioMockApi";

type TourStep =
  | "bootstrap"
  | "agent-nav"
  | "agent-preset"
  | "agent-send"
  | "overview"
  | "campaigns-nav"
  | "run-button"
  | "report"
  | "done";

interface TargetBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

// Buttons that should never be clickable in the demo, regardless of tour state —
// the demo runs a single workspace and never offers real workspace management.
const ALWAYS_LOCKED_LABELS = new Set<string>(["Remove from Studio"]);

// Buttons that act on the workspace (chat, scenario runs, campaign runs, thread
// management). The tour walks through one Send and one Run all click; once the
// tour is "done", these are locked so the user can only inspect the result.
const POST_TOUR_LOCKED_LABELS = new Set<string>([
  "Send",
  "Stop",
  "Run",
  "Run all",
  "Preview run",
  "New conversation",
  "Delete thread"
]);

export function App() {
  return (
    <>
      <StudioApp />
      <TourOverlay />
    </>
  );
}

export function installDemoBrowserHooks(): void {
  if (typeof window === "undefined") return;
  window.EventSource = DemoEventSource as unknown as typeof EventSource;
}

function TourOverlay() {
  const [snapshot, setSnapshot] = useState<DemoSnapshot>(() => demoStore.snapshot());
  const [target, setTarget] = useState<TargetBox | null>(null);
  const [page, setPage] = useState(() => currentPage());
  const [composerPrimed, setComposerPrimed] = useState(() => isComposerPrimed());

  useEffect(() => demoStore.subscribe(() => setSnapshot(demoStore.snapshot())), []);

  useEffect(() => {
    function sync() {
      setSnapshot(demoStore.snapshot());
      setPage(currentPage());
      setComposerPrimed(isComposerPrimed());
    }
    window.addEventListener("popstate", sync);
    window.addEventListener("riptide-demo-change", sync);
    const id = window.setInterval(sync, 350);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("riptide-demo-change", sync);
      window.clearInterval(id);
    };
  }, []);

  const step = useMemo(() => deriveStep(snapshot, page, composerPrimed), [snapshot, page, composerPrimed]);

  useEffect(() => {
    function measure() {
      const element = findTarget(step, page);
      if (!element) {
        setTarget(null);
        return;
      }
      const rect = element.getBoundingClientRect();
      setTarget({
        top: Math.max(0, rect.top - 8),
        left: Math.max(0, rect.left - 8),
        width: rect.width + 16,
        height: rect.height + 16
      });
    }
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    const id = window.setInterval(measure, 250);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      window.clearInterval(id);
    };
  }, [step, page]);

  useEffect(() => {
    if (snapshot.jobRunning && page !== "jobs") {
      routeTo("jobs", snapshot.workspace.id);
      return;
    }
    if (snapshot.configured && !snapshot.overviewSeen && page === "handoff") {
      routeTo("overview", snapshot.workspace.id);
    }
    if (snapshot.runComplete && !snapshot.reportSeen && page === "jobs") {
      routeTo("reports", snapshot.workspace.id, "artifact:report:demo-whale-shock");
    }
  }, [page, snapshot]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.innerWidth > 720) return;
    const needsDrawer = step === "agent-nav" || step === "campaigns-nav";
    const eventName = needsDrawer
      ? "riptide-mobile-nav-open"
      : "riptide-mobile-nav-close";
    window.dispatchEvent(new Event(eventName));
  }, [step]);

  useEffect(() => {
    document.body.classList.add("riptide-demo");
    return () => {
      document.body.classList.remove("riptide-demo");
    };
  }, []);

  useEffect(() => {
    const lockDoneActions = step === "done";

    function syncLocks() {
      const buttons = document.querySelectorAll<HTMLButtonElement>("button");
      for (const button of Array.from(buttons)) {
        const text = (button.textContent ?? "").trim();
        const isRailAdd = button.classList.contains("rail__add");
        const shouldLock =
          isRailAdd ||
          ALWAYS_LOCKED_LABELS.has(text) ||
          (lockDoneActions && POST_TOUR_LOCKED_LABELS.has(text));
        if (shouldLock) {
          if (button.dataset.demoLocked !== "true") {
            button.dataset.demoLocked = "true";
            button.setAttribute("aria-disabled", "true");
          }
        } else if (button.dataset.demoLocked === "true") {
          delete button.dataset.demoLocked;
          button.removeAttribute("aria-disabled");
        }
      }
    }

    syncLocks();
    const id = window.setInterval(syncLocks, 350);
    return () => window.clearInterval(id);
  }, [step]);

  if (step === "done") return <RerunButton />;
  if (snapshot.agentRunning || snapshot.jobRunning) return <InteractionLock />;

  const copy = copyFor(step, page);
  const box = target ?? fallbackTarget();
  const cardPosition = positionCard(box);

  return (
    <div className="tour-layer" aria-live="polite">
      <Blockers box={box} />
      <div className="tour-focus" style={boxStyle(box)} />
      <div className="tour-card" style={cardPosition}>
        <div className="tour-kicker">GUIDED DEMO</div>
        <h2>{copy.title}</h2>
        <p>{copy.body}</p>
        <div className="tour-actions">
          {copy.primary && (
            <button className="btn btn--primary btn--sm" onClick={() => handlePrimary(step, snapshot)}>
              <Icon name={copy.icon ?? "play"} size={12} />
              {copy.primary}
            </button>
          )}
          <button className="btn btn--ghost btn--sm" onClick={skipAndReload}>
            Skip and populate
          </button>
        </div>
      </div>
    </div>
  );
}

function InteractionLock() {
  return <div className="tour-interaction-lock" aria-hidden="true" />;
}

function RerunButton() {
  return (
    <button
      type="button"
      className="tour-rerun"
      onClick={rerunDemo}
      title="Replay the guided demo from the beginning"
    >
      <Icon name="refresh" size={13} />
      Rerun guided demo
    </button>
  );
}

function rerunDemo(): void {
  demoStore.reset();
  const url = new URL(window.location.href);
  url.searchParams.delete("page");
  url.searchParams.delete("artifact");
  url.searchParams.delete("workspace");
  window.location.assign(`${url.pathname}${url.search}${url.hash}`);
}

function Blockers({ box }: { box: TargetBox }) {
  const right = Math.max(0, window.innerWidth - box.left - box.width);
  const bottom = Math.max(0, window.innerHeight - box.top - box.height);
  return (
    <>
      <div className="tour-blocker" style={{ top: 0, left: 0, width: "100%", height: box.top }} />
      <div className="tour-blocker" style={{ top: box.top, left: 0, width: box.left, height: box.height }} />
      <div className="tour-blocker" style={{ top: box.top, right: 0, width: right, height: box.height }} />
      <div className="tour-blocker" style={{ bottom: 0, left: 0, width: "100%", height: bottom }} />
    </>
  );
}

function deriveStep(snapshot: DemoSnapshot, page: string, composerPrimed: boolean): TourStep {
  if (!snapshot.workspace.has_riptide) return "bootstrap";
  if (!snapshot.configured) return page === "handoff" ? composerPrimed ? "agent-send" : "agent-preset" : "agent-nav";
  if (!snapshot.overviewSeen) return "overview";
  if (!snapshot.runComplete) return page === "campaigns" ? "run-button" : "campaigns-nav";
  if (!snapshot.reportSeen) return "report";
  return "done";
}

function copyFor(step: TourStep, page: string): { title: string; body: string; primary?: string; icon?: "check" | "play" | "sparkles" } {
  if (step === "bootstrap") {
    return {
      title: "Create the demo workspace in the real Studio wizard.",
      body: "This is the same first-run modal Studio uses locally. Name the project, choose the agent, and confirm the workspace."
    };
  }
  if (step === "agent-nav") {
    return {
      title: "Open Agent chat to configure the workspace.",
      body: "Use the Studio sidebar to move into the agent workflow."
    };
  }
  if (step === "agent-preset") {
    return {
      title: "Start with Configure my project.",
      body: "This fills the composer with the setup request for the lending workspace."
    };
  }
  if (step === "agent-send") {
    return {
      title: "Send the configuration request.",
      body: "Studio will show the agent progress in the chat while it prepares adapters, scenarios, personas, and invariants."
    };
  }
  if (step === "overview") {
    return {
      title: "Overview is the first page to inspect after configuration.",
      body: "It shows the configured artifacts, graph-derived evidence, job status, and verdict counters before the first run.",
      primary: "I reviewed Overview",
      icon: "check"
    };
  }
  if (step === "campaigns-nav") {
    return {
      title: "Open Campaigns to launch the demo run.",
      body: "The agent wrote a campaign that sweeps the lending workspace. Click Campaigns, then use the highlighted Run all button.",
      primary: page === "campaigns" ? undefined : "Open Campaigns",
      icon: "play"
    };
  }
  if (step === "run-button") {
    return {
      title: "Run the campaign.",
      body: "Click Run all. Studio will move to the job queue while the campaign progresses, and route you to the report when it finishes."
    };
  }
  return {
    title: "Review the report.",
    body: "The report explains the result, the failing path, the reproduction command, and the next review target.",
    primary: "Finish",
    icon: "check"
  };
}

function handlePrimary(step: TourStep, snapshot: DemoSnapshot): void {
  if (step === "overview") {
    demoStore.markOverviewSeen();
    routeTo("campaigns", snapshot.workspace.id);
  } else if (step === "campaigns-nav") {
    routeTo("campaigns", snapshot.workspace.id);
  } else if (step === "report") {
    demoStore.markReportSeen();
  }
}

function findTarget(step: TourStep, page: string): HTMLElement | null {
  if (step === "bootstrap") return document.querySelector(".modal");
  if (step === "agent-nav") return buttonByText("Agent chat");
  if (step === "agent-preset") return buttonByText("Configure my project");
  if (step === "agent-send") return buttonByText("Send");
  if (step === "overview") return document.querySelector("main");
  if (step === "campaigns-nav") return page === "campaigns" ? buttonByText("Run all") : buttonByText("Campaigns");
  if (step === "run-button") return buttonByText("Run all");
  if (step === "report") return document.querySelector(".lview__detail") ?? document.querySelector("main");
  return null;
}

function buttonByText(text: string): HTMLElement | null {
  const buttons = [...document.querySelectorAll("button")];
  return buttons.find((button) => (button.textContent ?? "").trim().includes(text)) ?? null;
}

function routeTo(page: string, workspaceId: string, artifactId?: string): void {
  const url = new URL(window.location.href);
  if (page === "overview") url.searchParams.delete("page");
  else url.searchParams.set("page", page);
  url.searchParams.set("workspace", workspaceId);
  if (artifactId) url.searchParams.set("artifact", artifactId);
  else url.searchParams.delete("artifact");
  window.history.pushState({ page, workspaceId }, "", `${url.pathname}${url.search}${url.hash}`);
  window.dispatchEvent(new PopStateEvent("popstate", { state: { page, workspaceId } }));
}

function skipAndReload(): void {
  demoStore.skipToComplete();
  const workspaceId = demoStore.snapshot().workspace.id;
  const url = new URL(window.location.href);
  url.searchParams.delete("page");
  url.searchParams.delete("artifact");
  url.searchParams.set("workspace", workspaceId);
  window.location.assign(`${url.pathname}${url.search}${url.hash}`);
}

function currentPage(): string {
  return new URLSearchParams(window.location.search).get("page") ?? "overview";
}

function isComposerPrimed(): boolean {
  const textarea = document.querySelector("textarea");
  return (textarea instanceof HTMLTextAreaElement && textarea.value.trim().length > 0);
}

function fallbackTarget(): TargetBox {
  return { top: 96, left: 292, width: Math.max(320, window.innerWidth - 340), height: Math.max(220, window.innerHeight - 160) };
}

function boxStyle(box: TargetBox): React.CSSProperties {
  return {
    top: box.top,
    left: box.left,
    width: box.width,
    height: box.height
  };
}

function positionCard(box: TargetBox): React.CSSProperties {
  const width = Math.min(390, window.innerWidth - 28);
  const rightSide = box.left + box.width + 18;
  const leftSide = box.left - width - 18;
  const left = rightSide + width < window.innerWidth
    ? rightSide
    : leftSide > 14
      ? leftSide
      : Math.max(14, Math.min(window.innerWidth - width - 14, box.left));
  const below = box.top + box.height + 14;
  const top = below + 190 < window.innerHeight
    ? below
    : Math.max(14, Math.min(window.innerHeight - 220, box.top - 210));
  return { top, left, width };
}
