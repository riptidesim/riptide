import { Fragment, useState } from "react";

import { Icon, type IconName } from "../ui/Icon";
import { EmptyState, Kicker, PageLabel, Pill, type PillKind } from "../ui/primitives";

type JobKind = "sim" | "agent" | "val" | "camp";

interface Job {
  id: string;
  kind: JobKind;
  icon: IconName;
  label: string;
  pill: string;
  pk: PillKind;
  time: string;
  tick: string | null;
  cancel: boolean;
}

const JOBS: Job[] = [
  { id: "j_8f3c1", kind: "sim", icon: "play", label: "lending-liquidation-sweep", pill: "RUNNING", pk: "running", time: "4m", tick: "612 / 1000", cancel: true },
  { id: "j_a91d2", kind: "sim", icon: "play", label: "oracle-divergence-stress", pill: "RUNNING", pk: "running", time: "12m", tick: "248 / 500", cancel: true },
  { id: "j_t11", kind: "agent", icon: "sparkles", label: 'agent · "Add whale persona for lending sweep"', pill: "RUNNING", pk: "running", time: "2m", tick: "4 of 8 tools", cancel: true },
  { id: "j_v044", kind: "val", icon: "check", label: "riptide validate · adapter", pill: "QUEUED", pk: "queued", time: "queued", tick: null, cancel: true },
  { id: "j_camp1", kind: "camp", icon: "flame", label: "campaign · oracle-divergence × 32", pill: "QUEUED", pk: "queued", time: "queued", tick: null, cancel: true },
  { id: "j_b04ee", kind: "sim", icon: "play", label: "lp-imbalance-walk", pill: "PASS", pk: "pass", time: "21m ago", tick: "1000 / 1000", cancel: false },
  { id: "j_2cb71", kind: "sim", icon: "play", label: "funding-cascade", pill: "FAIL", pk: "fail", time: "38m ago", tick: "826 / 1000", cancel: false },
  { id: "j_t02", kind: "agent", icon: "sparkles", label: 'agent · "Tighten oracle bounds"', pill: "PASS", pk: "pass", time: "1h ago", tick: "12 tool calls", cancel: false },
  { id: "j_v041", kind: "val", icon: "check", label: "riptide validate · scenarios", pill: "PASS", pk: "pass", time: "2h ago", tick: "8 ok / 0 fail", cancel: false },
  { id: "j_77a13", kind: "sim", icon: "play", label: "lending-liquidation-sweep", pill: "PASS", pk: "pass", time: "4h ago", tick: "1000 / 1000", cancel: false },
  { id: "j_camp0", kind: "camp", icon: "flame", label: "campaign · liquidation × 64", pill: "FAIL", pk: "fail", time: "5h ago", tick: "42 / 64", cancel: false },
  { id: "j_t01", kind: "agent", icon: "sparkles", label: 'agent · "Wire v2 lending adapter"', pill: "PASS", pk: "pass", time: "yesterday", tick: "18 tool calls", cancel: false }
];

const KIND_FILTER: Record<string, JobKind | null> = {
  all: null,
  campaign: "camp",
  sim: "sim",
  val: "val",
  agent: "agent"
};

export function JobsPage({ populated }: { populated: boolean }) {
  const [tab, setTab] = useState<"all" | "running" | "queued" | "completed" | "failed">("all");
  const [kind, setKind] = useState<keyof typeof KIND_FILTER>("all");
  const [sel, setSel] = useState("j_a91d2");

  const list = JOBS.filter((j) => {
    const target = KIND_FILTER[kind];
    if (target && j.kind !== target) return false;
    if (tab === "running") return j.pk === "running";
    if (tab === "queued") return j.pk === "queued";
    if (tab === "completed") return j.pk === "pass";
    if (tab === "failed") return j.pk === "fail";
    return true;
  });
  const detail = JOBS.find((j) => j.id === sel)!;

  if (!populated) {
    return (
      <div>
        <PageLabel>JOB QUEUE</PageLabel>
        <div className="card" style={{ padding: 0 }}>
          <EmptyState
            icon="queue"
            title="Idle"
            body="Simulations, validations, and agent tasks queue up here. The queue is empty."
            ctaLabel="Run a scenario"
          />
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageLabel>JOB QUEUE</PageLabel>
      <div className="lview" style={{ gridTemplateColumns: "1.4fr 1fr" }}>
        <div className="lview__list">
          <div className="lview__list-head" style={{ gap: 8 }}>
            <div className="chips">
              {([
                ["all", "All kinds"],
                ["campaign", "Campaign run"],
                ["sim", "Single sim"],
                ["val", "Validation"],
                ["agent", "Agent task"]
              ] as const).map(([k, l]) => (
                <button key={k} className={`chip${kind === k ? " chip--active" : ""}`} onClick={() => setKind(k)}>
                  {l}
                </button>
              ))}
            </div>
            <div className="chips">
              {(["all", "running", "queued", "completed", "failed"] as const).map((t) => (
                <button key={t} className={`chip${tab === t ? " chip--active" : ""}`} onClick={() => setTab(t)}>
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div className="lview__list-body">
            {list.map((j) => (
              <div
                key={j.id}
                className={`lview__row${sel === j.id ? " lview__row--active" : ""}`}
                onClick={() => setSel(j.id)}
              >
                <div className="lview__row-top">
                  <span className="side__item-icon">
                    <Icon name={j.icon} size={14} color="var(--rt-fog-dim)" />
                  </span>
                  <span className="lview__row-name">{j.label}</span>
                  <Pill kind={j.pk} dot={j.pk === "running"}>{j.pill}</Pill>
                </div>
                <div className="lview__row-meta">
                  <span style={{ fontFamily: "IBM Plex Mono" }}>{j.id}</span>
                  <span>·</span>
                  <span>{j.time}</span>
                  {j.tick && (
                    <Fragment>
                      <span>·</span>
                      <span style={{ fontFamily: "IBM Plex Mono", color: j.pk === "running" ? "var(--rt-teal)" : "var(--rt-fog-dim)" }}>
                        {j.tick}
                      </span>
                    </Fragment>
                  )}
                  {j.pk === "running" && (
                    <div style={{ flex: 1, marginLeft: "auto", maxWidth: 120 }}>
                      <div className="simcard__bar">
                        <div className="simcard__bar-fill" style={{ width: "60%" }} />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="lview__detail" style={{ background: "var(--rt-ink)" }}>
          <Kicker style={{ marginBottom: 6 }}>
            {detail.kind === "sim"
              ? "SIMULATION"
              : detail.kind === "agent"
              ? "AGENT TASK"
              : detail.kind === "val"
              ? "VALIDATION"
              : "CAMPAIGN"}
          </Kicker>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
            <h2 style={{ font: "500 18px Inter", margin: 0, color: "var(--rt-off-white)" }}>{detail.label}</h2>
            <Pill kind={detail.pk} dot={detail.pk === "running"}>
              {detail.pill}
            </Pill>
          </div>
          <div style={{ font: '400 12px "IBM Plex Mono"', color: "var(--rt-fog-dim)", marginBottom: 14 }}>
            {detail.id} · started {detail.time}
            {detail.tick ? ` · ${detail.tick}` : ""}
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
            {detail.cancel && detail.pk === "running" && (
              <button className="btn btn--ghost btn--sm">
                <Icon name="stop" size={12} />
                Cancel
              </button>
            )}
            {detail.pk === "pass" && (
              <button className="btn btn--primary btn--sm">
                <Icon name="file" size={13} />
                Open report
              </button>
            )}
            <button className="btn btn--ghost btn--sm">
              <Icon name="terminal" size={13} />
              Open in terminal
            </button>
          </div>

          <Kicker style={{ marginBottom: 6 }}>ARGV</Kicker>
          <div className="code" style={{ marginBottom: 18 }}>
            <span style={{ color: "var(--rt-teal)" }}>$</span> riptide run {detail.label.split(" · ")[0]} \
            {"\n"}    --seed 0x9f3a2c66...c1b8 \
            {"\n"}    --ticks 1000 --tps 2400 \
            {"\n"}    --out .riptide/runs/{detail.id}/
          </div>

          <Kicker style={{ marginBottom: 6 }}>STREAMING LOG</Kicker>
          <div className="code" style={{ height: 240, overflowY: "auto", whiteSpace: "pre" }}>
            <span style={{ color: "var(--rt-fog-dim)" }}>[14:22:01]</span> initialize state                     <span style={{ color: "var(--rt-pass)" }}>ok</span>
            {"\n"}
            <span style={{ color: "var(--rt-fog-dim)" }}>[14:22:02]</span> mount adapter lending.so            <span style={{ color: "var(--rt-pass)" }}>ok</span>
            {"\n"}
            <span style={{ color: "var(--rt-fog-dim)" }}>[14:22:02]</span> seed personas (3)                   <span style={{ color: "var(--rt-pass)" }}>ok</span>
            {"\n"}
            <span style={{ color: "var(--rt-fog-dim)" }}>[14:22:03]</span> [tick    0] deposit collateral      <span style={{ color: "var(--rt-pass)" }}>ok</span>
            {"\n"}
            <span style={{ color: "var(--rt-fog-dim)" }}>[14:22:03]</span> [tick  100] open position           <span style={{ color: "var(--rt-pass)" }}>ok</span>
            {"\n"}
            <span style={{ color: "var(--rt-fog-dim)" }}>[14:22:04]</span> [tick  200] price move -8%          <span style={{ color: "var(--rt-pass)" }}>ok</span>
            {"\n"}
            <span style={{ color: "var(--rt-fog-dim)" }}>[14:22:05]</span> [tick  248] <span style={{ color: "var(--rt-warn)" }}>OracleBounds breach (28 bps)</span>
            {"\n"}
            <span style={{ color: "var(--rt-fog-dim)" }}>[14:22:05]</span> [tick  248] invariant warn logged   <span style={{ color: "var(--rt-warn)" }}>warn</span>
            {"\n"}
            <span style={{ color: "var(--rt-fog-dim)" }}>[14:22:06]</span> [tick  300] arb-bot rebalance       <span style={{ color: "var(--rt-pass)" }}>ok</span>
            {"\n"}
            <span style={{ color: "var(--rt-teal)" }}>[14:22:06]</span> streaming…
            <span
              style={{
                display: "inline-block",
                width: 6,
                height: 13,
                background: "var(--rt-teal)",
                verticalAlign: "-2px",
                marginLeft: 4,
                animation: "pulse 1s ease-in-out infinite"
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
