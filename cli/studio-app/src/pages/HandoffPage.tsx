import type { CSSProperties } from "react";

import { Icon } from "../ui/Icon";
import { Kicker, PageLabel, Pill } from "../ui/primitives";

const THREADS = [
  { id: "t1", title: "Add a whale persona for the lending sweep", time: "2m ago", active: true },
  { id: "t2", title: "Tighten oracle-divergence invariant bounds", time: "1h ago" },
  { id: "t3", title: "Define a flash-loan attacker scenario", time: "yesterday" },
  { id: "t4", title: "Wire adapter for v2 lending program", time: "3d ago" },
  { id: "t5", title: "Add LP imbalance campaign", time: "5d ago" }
];

type Message =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; showDiff?: boolean }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; icon: string; summary: string };

const MESSAGES: Message[] = [
  { kind: "user", text: "Add a whale persona that holds 40% of pool liquidity and unwinds over 600 ticks. Reference it from the lending-liquidation-sweep scenario." },
  { kind: "assistant", text: "I'll outline the persona, write the YAML to `.riptide/personas/`, then update the scenario reference. One moment." },
  { kind: "thinking", text: "Considering reference scenario shape, persona schema, and probabilistic unwind cadence. Will use a linear schedule unless told otherwise." },
  { kind: "tool", icon: "·", summary: "Read .riptide/personas/whale.yaml" },
  { kind: "tool", icon: "+", summary: "Wrote .riptide/personas/whale-deep.yaml (+47 lines)" },
  { kind: "assistant", text: "Drafted `whale-deep` with a linear unwind from `tick=0..600`, sized to `0.40` of `pool.tvl` at scenario start. Schema validates.\n\nUpdating the scenario next." },
  { kind: "tool", icon: "~", summary: "Edited .riptide/scenarios/lending-liquidation-sweep.yaml (+2, −0)" },
  { kind: "tool", icon: ">", summary: "Ran `riptide validate`" },
  { kind: "assistant", text: "`riptide validate` is green. The scenario now references `whale-deep` alongside the existing retail and arbitrageur personas.\n\nWant me to dispatch a single-shot run to confirm the unwind shape, or hold here for review?" },
  { kind: "user", text: "Hold for review. Show me the diff for the scenario edit." },
  { kind: "assistant", text: "Here's the unified diff. The change attaches `whale-deep` to the persona list and bumps the seed to keep the existing run hashes stable.", showDiff: true }
];

const DIFF_LINES: { num: string; add?: boolean; rem?: boolean; t: string }[] = [
  { num: "32", t: "  personas:" },
  { num: "33", t: "    - retail-trader" },
  { num: "34", t: "    - arb-bot" },
  { num: "35", rem: true, t: "    seed: 0x9f3a" },
  { num: "35", add: true, t: "    - whale-deep" },
  { num: "36", add: true, t: "  seed: 0x9f3a...c1b8" }
];

const WS_FILES = [
  { path: ".riptide/personas/whale-deep.yaml", kind: "add", loc: "+47" },
  { path: ".riptide/scenarios/lending-sweep.yaml", kind: "edit", loc: "+2 −0" },
  { path: ".riptide/.cache/validate.log", kind: "touch", loc: "·" }
];

const ASSIST_BUBBLE: CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 6,
  background: "var(--rt-teal-ink)",
  border: "1px solid rgba(20,184,182,0.35)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "none"
};

function ChatMessage({ m }: { m: Message }) {
  if (m.kind === "user") {
    return (
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 18 }}>
        <div
          style={{
            background: "var(--rt-slate-2)",
            border: "1px solid var(--rt-slate-line)",
            borderRadius: 12,
            padding: "10px 14px",
            maxWidth: 540,
            font: "400 14px/1.55 Inter, sans-serif",
            color: "var(--rt-off-white)"
          }}
        >
          {m.text}
        </div>
      </div>
    );
  }
  if (m.kind === "assistant") {
    return (
      <div style={{ display: "flex", gap: 12, marginBottom: 18 }}>
        <div style={ASSIST_BUBBLE}>
          <Icon name="sparkles" size={13} color="var(--rt-teal)" />
        </div>
        <div style={{ flex: 1, font: "400 14px/1.6 Inter, sans-serif", color: "var(--rt-fg-1)", whiteSpace: "pre-wrap" }}>
          {m.text}
          {m.showDiff && (
            <div className="diff" style={{ marginTop: 12 }}>
              {DIFF_LINES.map((l, i) => (
                <div key={i} className={`diff__line${l.add ? " diff__line--add" : ""}${l.rem ? " diff__line--rem" : ""}`}>
                  <span className="diff__num">{l.num}</span>
                  <span>
                    {l.add ? "+" : l.rem ? "-" : " "} {l.t}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }
  if (m.kind === "thinking") {
    return (
      <div style={{ marginBottom: 18, marginLeft: 36 }}>
        <button
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            background: "transparent",
            border: "none",
            color: "var(--rt-fog-dim)",
            font: "400 12px Inter",
            cursor: "pointer"
          }}
        >
          <Icon name="chevron" size={12} />
          thinking ({Math.ceil(m.text.length / 30)}s)
        </button>
      </div>
    );
  }
  // tool
  return (
    <div style={{ marginBottom: 8, marginLeft: 36 }}>
      <button
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: "var(--rt-ink)",
          border: "1px solid var(--rt-slate-line)",
          borderRadius: 6,
          padding: "6px 10px",
          color: "var(--rt-fg-2)",
          font: '400 12.5px "IBM Plex Mono"',
          cursor: "pointer",
          width: "100%",
          textAlign: "left"
        }}
      >
        <Icon name="chevron" size={12} color="var(--rt-fog-dim)" />
        <span style={{ flex: "none" }}>{m.icon}</span>
        <span style={{ flex: 1, color: "var(--rt-fg-1)" }}>{m.summary}</span>
        <Pill kind="pass">DONE</Pill>
      </button>
    </div>
  );
}

export function HandoffPage() {
  return (
    <div>
      <PageLabel>CONFIG HANDOFF</PageLabel>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "240px 1fr 280px",
          gap: 0,
          height: "calc(100vh - 110px)",
          background: "var(--rt-slate-panel)",
          border: "1px solid var(--rt-slate-line)",
          borderRadius: 12,
          overflow: "hidden"
        }}
      >
        {/* Thread list */}
        <div style={{ borderRight: "1px solid var(--rt-slate-line)", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: 14, borderBottom: "1px solid var(--rt-slate-line)" }}>
            <button className="btn btn--ghost btn--sm" style={{ width: "100%", justifyContent: "center" }}>
              <Icon name="plus" size={13} /> New conversation
            </button>
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {THREADS.map((t) => (
              <button
                key={t.id}
                style={{
                  width: "100%",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-start",
                  padding: "11px 14px",
                  background: t.active ? "var(--rt-slate-2)" : "transparent",
                  border: "none",
                  borderBottom: "1px solid var(--rt-slate-line)",
                  cursor: "pointer",
                  textAlign: "left",
                  gap: 4
                }}
              >
                <span
                  style={{
                    font: "500 13px/1.35 Inter",
                    color: "var(--rt-off-white)",
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden"
                  }}
                >
                  {t.title}
                </span>
                <span style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)" }}>{t.time}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Chat center */}
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <div
            style={{
              padding: "14px 24px",
              borderBottom: "1px solid var(--rt-slate-line)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between"
            }}
          >
            <div>
              <div style={{ font: "500 13px Inter", color: "var(--rt-off-white)" }}>Add a whale persona for the lending sweep</div>
              <div style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)", marginTop: 3 }}>
                claude-code · 2 minutes · 8 tool calls
              </div>
            </div>
            <Pill kind="pass" dot>RUNNING</Pill>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
            {MESSAGES.map((m, i) => (
              <ChatMessage key={i} m={m} />
            ))}
            <div style={{ display: "flex", gap: 12, marginBottom: 18 }}>
              <div style={ASSIST_BUBBLE}>
                <Icon name="sparkles" size={13} color="var(--rt-teal)" />
              </div>
              <div style={{ flex: 1, font: "400 14px/1.6 Inter", color: "var(--rt-fg-1)" }}>
                Reviewing&nbsp;
                <span
                  style={{
                    display: "inline-block",
                    width: 6,
                    height: 14,
                    background: "var(--rt-teal)",
                    verticalAlign: "-2px",
                    animation: "pulse 1s ease-in-out infinite"
                  }}
                />
              </div>
            </div>
          </div>
          <div style={{ padding: 14, borderTop: "1px solid var(--rt-slate-line)" }}>
            <div
              style={{
                background: "var(--rt-ink)",
                border: "1px solid var(--rt-slate-line)",
                borderRadius: 10,
                padding: 10
              }}
            >
              <textarea
                placeholder="Tell the agent what to change. ⌘↵ to send."
                rows={2}
                className="textarea"
                style={{
                  background: "transparent",
                  border: "none",
                  resize: "none",
                  padding: 4,
                  color: "var(--rt-off-white)"
                }}
                defaultValue=""
              />
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                <button className="side__util-btn" title="Attach file">
                  <Icon name="paperclip" size={15} />
                </button>
                <span style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)" }}>
                  claude-code · default model
                </span>
                <div style={{ flex: 1 }} />
                <button className="btn btn--ghost btn--sm">
                  <Icon name="stop" size={12} />
                  Stop
                </button>
                <button className="btn btn--primary btn--sm">
                  <Icon name="send" size={13} />
                  Send
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Workspace changes */}
        <div style={{ borderLeft: "1px solid var(--rt-slate-line)", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--rt-slate-line)" }}>
            <Kicker>WORKSPACE CHANGES</Kicker>
            <div style={{ font: "500 13px Inter", color: "var(--rt-off-white)", marginTop: 6 }}>3 files</div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
            {WS_FILES.map((f, i) => (
              <div key={i} style={{ padding: "10px 16px", borderBottom: "1px solid var(--rt-slate-line)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <span
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 3,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      font: '500 10px "IBM Plex Mono"',
                      background:
                        f.kind === "add"
                          ? "rgba(34,197,94,0.12)"
                          : f.kind === "edit"
                          ? "rgba(20,184,182,0.12)"
                          : "var(--rt-slate-2)",
                      color:
                        f.kind === "add"
                          ? "var(--rt-pass)"
                          : f.kind === "edit"
                          ? "var(--rt-teal)"
                          : "var(--rt-fog-dim)"
                    }}
                  >
                    {f.kind === "add" ? "A" : f.kind === "edit" ? "M" : "·"}
                  </span>
                  <span style={{ font: '400 12px "IBM Plex Mono"', color: "var(--rt-fog-dim)", marginLeft: "auto" }}>
                    {f.loc}
                  </span>
                </div>
                <div style={{ font: '400 12px/1.4 "IBM Plex Mono"', color: "var(--rt-off-white)", wordBreak: "break-all" }}>
                  {f.path}
                </div>
                <button className="btn btn--quiet btn--sm" style={{ marginTop: 6, padding: "2px 0" }}>
                  <Icon name="eye" size={12} />
                  Review diff
                </button>
              </div>
            ))}
          </div>
          <div style={{ padding: 14, borderTop: "1px solid var(--rt-slate-line)" }}>
            <button className="btn btn--ghost btn--sm" style={{ width: "100%", justifyContent: "center" }}>
              <Icon name="check" size={13} /> Mark reviewed
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
