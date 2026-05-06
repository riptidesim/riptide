import { useState, type CSSProperties, type ReactNode } from "react";

import { Icon, type IconName } from "../ui/Icon";
import { Kicker, PageLabel, Pill, type PillKind } from "../ui/primitives";
import { TabStrip } from "../ui/TabStrip";
import type { PageId } from "../shell/types";

interface SectionHeadProps {
  kicker?: string;
  title: string;
  sub?: string;
  onEdit?: () => void;
  right?: ReactNode;
}

function SectionHead({ kicker, title, sub, onEdit, right }: SectionHeadProps) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 14 }}>
      <div style={{ flex: 1 }}>
        {kicker && <Kicker style={{ marginBottom: 4 }}>{kicker}</Kicker>}
        <div style={{ font: "600 16px Inter", color: "var(--rt-off-white)" }}>{title}</div>
        {sub && <div style={{ font: "400 12px Inter", color: "var(--rt-fg-2)", marginTop: 4 }}>{sub}</div>}
      </div>
      {right}
      {onEdit && (
        <button className="btn btn--ghost btn--sm" onClick={onEdit}>
          <Icon name="sparkles" size={12} />
          Edit with agent
        </button>
      )}
    </div>
  );
}

function ProtocolStrip() {
  const [copied, setCopied] = useState(false);
  const programId = "LendF1Vr8KkN9z2WQqJyT3hP4mE6sX7Yc8B1aN5oM2J";
  const truncated = programId.slice(0, 6) + "…" + programId.slice(-6);
  const copy = () => {
    navigator.clipboard?.writeText(programId).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  const labelStyle: CSSProperties = {
    font: '500 10px "IBM Plex Mono"',
    color: "var(--rt-fog-dim)",
    letterSpacing: "0.08em",
    marginBottom: 4
  };
  return (
    <div className="card" style={{ padding: 14, marginBottom: 12, display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
      <div>
        <div style={labelStyle}>PROGRAM ID</div>
        <button
          onClick={copy}
          title={programId}
          style={{
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            font: '500 13px "IBM Plex Mono"',
            color: "var(--rt-off-white)",
            display: "inline-flex",
            alignItems: "center",
            gap: 6
          }}
        >
          <span>{truncated}</span>
          {copied ? <Icon name="check" size={11} color="var(--rt-teal)" /> : <Icon name="copy" size={11} color="var(--rt-fog-dim)" />}
        </button>
      </div>
      <div style={{ width: 1, height: 28, background: "var(--rt-slate-line)" }} />
      <div>
        <div style={labelStyle}>NETWORK</div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span className="dot dot--pass" />
          <span style={{ font: "500 13px Inter", color: "var(--rt-off-white)" }}>devnet</span>
        </div>
      </div>
      <div style={{ width: 1, height: 28, background: "var(--rt-slate-line)" }} />
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={labelStyle}>SOURCE</div>
        <div style={{ font: '500 12px "IBM Plex Mono"', color: "var(--rt-off-white)" }}>
          ~/code/lending-fund/.riptide/adapter.yaml
        </div>
      </div>
      <button className="btn btn--ghost btn--sm">
        <Icon name="external" size={11} />
        Open in editor
      </button>
    </div>
  );
}

function ValidationBanner() {
  const cfg = {
    bg: "rgba(255,179,71,0.06)",
    border: "rgba(255,179,71,0.32)",
    label: "VALIDATION",
    title: "2 warnings — adapter is usable",
    sub: "Last riptide validate · 11s ago · 0 errors · 2 warnings"
  };
  return (
    <div
      style={{
        background: cfg.bg,
        border: `1px solid ${cfg.border}`,
        borderRadius: 8,
        padding: "12px 14px",
        marginBottom: 18,
        display: "flex",
        alignItems: "center",
        gap: 12
      }}
    >
      <span className="dot dot--queued" style={{ width: 10, height: 10 }} />
      <div style={{ flex: 1 }}>
        <div style={{ font: '500 10px "IBM Plex Mono"', color: "var(--rt-fog-dim)", letterSpacing: "0.08em", marginBottom: 2 }}>
          {cfg.label}
        </div>
        <div style={{ font: "500 13px Inter", color: "var(--rt-off-white)" }}>{cfg.title}</div>
        <div style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)", marginTop: 2 }}>{cfg.sub}</div>
      </div>
      <button className="btn btn--ghost btn--sm">
        <Icon name="refresh" size={12} />
        Re-validate
      </button>
    </div>
  );
}

interface FactCard { label: string; value: string; kind: PillKind }

function ManifestTab() {
  const facts: FactCard[] = [
    { label: "PROTOCOL CLASS", value: "lending", kind: "info" },
    { label: "RISK GOAL", value: "liquidation cascade", kind: "warn" },
    { label: "EVIDENCE BOUNDARY", value: "state + invariants", kind: "info" },
    { label: "HARNESS KIND", value: "svm-replay", kind: "info" }
  ];
  const manifestText = `adapter:
  name: lending-fund
  class: lending
  version: 0.31

risk:
  goal: liquidation_cascade
  scope: pool_health

evidence:
  boundary: state + invariants
  diff_against: golden_run

harness:
  kind: svm-replay
  toolchain: solana-cli 1.18.26
  binary: target/deploy/lending.so`;
  return (
    <div className="card" style={{ padding: 22 }}>
      <SectionHead
        kicker="MANIFEST"
        title="Top-level adapter declaration"
        sub="What kind of protocol this is, what we're trying to expose, and how we run it."
        onEdit={() => {}}
      />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8, marginBottom: 20 }}>
        {facts.map((f) => (
          <div
            key={f.label}
            style={{
              background: "var(--rt-slate-2)",
              border: "1px solid var(--rt-slate-line)",
              borderRadius: 6,
              padding: "12px 14px"
            }}
          >
            <div
              style={{
                font: '500 10px "IBM Plex Mono"',
                color: "var(--rt-fog-dim)",
                letterSpacing: "0.08em",
                marginBottom: 6
              }}
            >
              {f.label}
            </div>
            <Pill kind={f.kind}>{f.value}</Pill>
          </div>
        ))}
      </div>

      <div style={{ font: '500 10px "IBM Plex Mono"', color: "var(--rt-fog-dim)", letterSpacing: "0.08em", marginBottom: 6 }}>
        RENDERED MANIFEST
      </div>
      <pre
        style={{
          margin: 0,
          padding: 14,
          background: "var(--rt-slate-2)",
          border: "1px solid var(--rt-slate-line)",
          borderRadius: 6,
          font: '400 12px/1.6 "IBM Plex Mono"',
          color: "var(--rt-fg-2)",
          overflow: "auto"
        }}
      >
        {manifestText}
      </pre>
    </div>
  );
}

interface AccountRow {
  id: string;
  name: string;
  kind: "pda" | "config" | "mint" | "token";
  icon: IconName;
  seed: string;
  fields: number;
  desc: string;
}

const ACCOUNTS: AccountRow[] = [
  { id: "pool", name: "Pool", kind: "pda", icon: "database", seed: '["pool", market_id]', fields: 8, desc: "Per-market lending pool root" },
  { id: "user_position", name: "UserPosition", kind: "pda", icon: "database", seed: '["pos", pool, owner]', fields: 12, desc: "Per-user position inside a pool" },
  { id: "reserve", name: "Reserve", kind: "pda", icon: "database", seed: '["reserve", pool, mint]', fields: 14, desc: "Per-asset reserve state (cash, debt, fees)" },
  { id: "oracle_feed", name: "OracleFeed", kind: "config", icon: "eye", seed: "pyth account address", fields: 6, desc: "External price feed reference" },
  { id: "collateral_mint", name: "CollateralMint", kind: "mint", icon: "coin", seed: "spl-token Mint", fields: 5, desc: "cToken mint for a reserve" },
  { id: "fee_vault", name: "FeeVault", kind: "token", icon: "wallet", seed: "spl-token Account", fields: 4, desc: "Protocol fee accumulator" },
  { id: "liquidator", name: "Liquidator", kind: "pda", icon: "database", seed: '["liq", pool, key]', fields: 7, desc: "Registered liquidator state" },
  { id: "config", name: "Config", kind: "config", icon: "settings", seed: '["config"]', fields: 22, desc: "Global program parameters" },
  { id: "flash_loan", name: "FlashLoan", kind: "pda", icon: "database", seed: '["flash", pool, slot]', fields: 5, desc: "In-flight flash loan record" },
  { id: "guard", name: "Guard", kind: "pda", icon: "database", seed: '["guard", market_id]', fields: 4, desc: "Circuit-breaker state" },
  { id: "rewards", name: "Rewards", kind: "pda", icon: "database", seed: '["rewards", pool]', fields: 9, desc: "Reward emissions tracker" },
  { id: "admin", name: "Admin", kind: "config", icon: "settings", seed: "multisig address", fields: 3, desc: "Privileged authority" }
];

const KIND_LABEL: Record<AccountRow["kind"], string> = {
  pda: "PDA",
  mint: "Mint",
  token: "Token Acct",
  config: "Config"
};

function AccountDetail({ acct }: { acct: AccountRow }) {
  const sample: Record<string, { name: string; type: string; desc: string }[]> = {
    pool: [
      { name: "market_id", type: "Pubkey", desc: "Stable identifier for this pool" },
      { name: "authority", type: "Pubkey", desc: "PDA authority for owned accounts" },
      { name: "collateral_mint", type: "Pubkey", desc: "cToken mint reference" },
      { name: "reserve_count", type: "u8", desc: "Number of reserves in this pool" },
      { name: "total_borrowed", type: "u128", desc: "Aggregate debt, in shares" },
      { name: "total_supplied", type: "u128", desc: "Aggregate supply, in shares" },
      { name: "last_update", type: "i64", desc: "Unix slot of last interest accrual" },
      { name: "flags", type: "u32", desc: "Bitset (paused, frozen, etc.)" }
    ]
  };
  const fields =
    sample[acct.id] ??
    Array.from({ length: acct.fields }, (_, i) => ({
      name: `field_${i}`,
      type: "u64",
      desc: "…"
    }));
  return (
    <div style={{ border: "1px solid var(--rt-slate-line)", borderRadius: 6, padding: 14, background: "var(--rt-slate-2)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <Icon name={acct.icon} size={14} color="var(--rt-teal)" />
        <div style={{ font: "600 15px Inter", color: "var(--rt-off-white)" }}>{acct.name}</div>
        <Pill kind="info">{KIND_LABEL[acct.kind]}</Pill>
      </div>
      <div style={{ font: "400 12px Inter", color: "var(--rt-fg-2)", marginBottom: 4 }}>{acct.desc}</div>
      <div style={{ font: '500 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)", marginBottom: 12 }}>seed · {acct.seed}</div>

      <div style={{ font: '500 10px "IBM Plex Mono"', color: "var(--rt-fog-dim)", letterSpacing: "0.08em", marginBottom: 6 }}>
        SCHEMA · {fields.length} fields
      </div>
      <table className="ptable">
        <thead>
          <tr>
            <th>field</th>
            <th>type</th>
            <th>description</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f.name}>
              <td style={{ font: '500 12px "IBM Plex Mono"', color: "var(--rt-off-white)" }}>{f.name}</td>
              <td style={{ font: '400 12px "IBM Plex Mono"', color: "var(--rt-teal)" }}>{f.type}</td>
              <td style={{ font: "400 12px Inter", color: "var(--rt-fg-2)" }}>{f.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AccountsTab() {
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const filt = ACCOUNTS.filter((a) => !q || a.name.toLowerCase().includes(q.toLowerCase()));
  const open = filt.find((a) => a.id === openId) ?? null;
  return (
    <div className="card" style={{ padding: 22 }}>
      <SectionHead
        kicker="ACCOUNTS"
        title={`Account map · ${ACCOUNTS.length} mapped`}
        sub="Every account type and PDA Riptide knows about. Click a row to inspect its schema."
        onEdit={() => {}}
        right={
          <div style={{ position: "relative" }}>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search accounts…"
              style={{
                background: "var(--rt-slate-2)",
                border: "1px solid var(--rt-slate-line)",
                borderRadius: 6,
                padding: "8px 10px 8px 30px",
                color: "var(--rt-off-white)",
                font: "400 12px Inter",
                width: 220,
                outline: "none"
              }}
            />
            <span style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", display: "inline-flex" }}>
              <Icon name="search" size={12} color="var(--rt-fog-dim)" />
            </span>
          </div>
        }
      />

      <div style={{ display: "grid", gridTemplateColumns: open ? "1fr 1fr" : "1fr", gap: 14 }}>
        <div style={{ border: "1px solid var(--rt-slate-line)", borderRadius: 6, overflow: "hidden" }}>
          <div className="ad-list-head">
            <span style={{ width: 130 }}>NAME</span>
            <span style={{ width: 80 }}>KIND</span>
            <span style={{ flex: 1 }}>SEED</span>
            <span style={{ width: 50, textAlign: "right" }}>FIELDS</span>
          </div>
          {filt.map((a) => (
            <button
              key={a.id}
              onClick={() => setOpenId(a.id === openId ? null : a.id)}
              className={`ad-list-row${a.id === openId ? " ad-list-row--active" : ""}`}
            >
              <span style={{ width: 130, display: "inline-flex", alignItems: "center", gap: 8 }}>
                <Icon name={a.icon} size={12} color="var(--rt-teal)" />
                <span style={{ font: "500 13px Inter", color: "var(--rt-off-white)" }}>{a.name}</span>
              </span>
              <span style={{ width: 80, font: '500 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)", letterSpacing: "0.04em" }}>
                {KIND_LABEL[a.kind]}
              </span>
              <span
                style={{
                  flex: 1,
                  font: '400 11px "IBM Plex Mono"',
                  color: "var(--rt-fg-2)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap"
                }}
              >
                {a.seed}
              </span>
              <span style={{ width: 50, textAlign: "right", font: '500 12px "IBM Plex Mono"', color: "var(--rt-off-white)" }}>
                {a.fields}
              </span>
            </button>
          ))}
        </div>

        {open && <AccountDetail acct={open} />}
      </div>
    </div>
  );
}

interface InstructionRow {
  id: string;
  name: string;
  accts: number;
  args: number;
  hooks: string[];
  desc: string;
}

const INSTRUCTIONS: InstructionRow[] = [
  { id: "init_pool", name: "init_pool", accts: 6, args: 4, hooks: ["after-tick"], desc: "Create a new lending pool with config parameters." },
  { id: "add_reserve", name: "add_reserve", accts: 7, args: 5, hooks: ["after-tick"], desc: "Register an asset as a reserve in an existing pool." },
  { id: "deposit", name: "deposit", accts: 8, args: 1, hooks: ["before-tick", "after-tick"], desc: "Supply liquidity into a reserve, mint cTokens." },
  { id: "withdraw", name: "withdraw", accts: 8, args: 1, hooks: ["before-tick", "after-tick"], desc: "Burn cTokens, redeem underlying liquidity." },
  { id: "borrow", name: "borrow", accts: 9, args: 2, hooks: ["before-tick", "after-tick", "on-borrow"], desc: "Take a loan against collateral. Updates utilization." },
  { id: "repay", name: "repay", accts: 8, args: 1, hooks: ["before-tick", "after-tick"], desc: "Pay down debt; releases collateral proportionally." },
  { id: "liquidate", name: "liquidate", accts: 11, args: 2, hooks: ["before-tick", "on-liquidation", "after-tick"], desc: "Seize unhealthy collateral; pay liquidation bonus." },
  { id: "flash_loan", name: "flash_loan", accts: 6, args: 2, hooks: ["on-flash-begin", "on-flash-end"], desc: "Atomic borrow-and-repay within a single instruction." },
  { id: "accrue", name: "accrue_interest", accts: 3, args: 0, hooks: ["on-accrue"], desc: "Compound interest based on slot delta." },
  { id: "set_oracle", name: "set_oracle", accts: 3, args: 1, hooks: [], desc: "Admin-only: rotate price feed reference." }
];

function InstructionDetail({ ix }: { ix: InstructionRow }) {
  const args: Record<string, { name: string; type: string; desc: string }[]> = {
    deposit: [{ name: "amount", type: "u64", desc: "Underlying tokens to supply" }],
    borrow: [
      { name: "amount", type: "u64", desc: "Underlying tokens to borrow" },
      { name: "reserve_index", type: "u8", desc: "Which reserve in the pool" }
    ],
    liquidate: [
      { name: "repay_amount", type: "u64", desc: "Debt amount the liquidator covers" },
      { name: "min_collateral", type: "u64", desc: "Slippage protection" }
    ]
  };
  const accts: Record<string, string[]> = {
    deposit: ["user", "pool", "reserve", "user_position", "collateral_mint", "fee_vault", "token_program", "system_program"],
    borrow: ["user", "pool", "reserve", "user_position", "oracle_feed", "collateral_mint", "fee_vault", "guard", "token_program"],
    liquidate: [
      "liquidator",
      "borrower_position",
      "pool",
      "reserve_debt",
      "reserve_collateral",
      "oracle_feed",
      "collateral_mint",
      "fee_vault",
      "guard",
      "token_program",
      "system_program"
    ]
  };
  const a =
    args[ix.id] ??
    Array.from({ length: ix.args }, (_, i) => ({ name: `arg_${i}`, type: "u64", desc: "…" }));
  const ac = accts[ix.id] ?? Array.from({ length: ix.accts }, (_, i) => `account_${i}`);
  return (
    <div style={{ border: "1px solid var(--rt-slate-line)", borderRadius: 6, padding: 14, background: "var(--rt-slate-2)" }}>
      <div style={{ font: '500 14px "IBM Plex Mono"', color: "var(--rt-off-white)", marginBottom: 4 }}>{ix.name}</div>
      <div style={{ font: "400 12px Inter", color: "var(--rt-fg-2)", marginBottom: 14 }}>{ix.desc}</div>

      <div style={{ font: '500 10px "IBM Plex Mono"', color: "var(--rt-fog-dim)", letterSpacing: "0.08em", marginBottom: 6 }}>
        ARGUMENTS · {a.length}
      </div>
      <table className="ptable" style={{ marginBottom: 14 }}>
        <thead>
          <tr>
            <th>arg</th>
            <th>type</th>
            <th>description</th>
          </tr>
        </thead>
        <tbody>
          {a.map((x) => (
            <tr key={x.name}>
              <td style={{ font: '500 12px "IBM Plex Mono"', color: "var(--rt-off-white)" }}>{x.name}</td>
              <td style={{ font: '400 12px "IBM Plex Mono"', color: "var(--rt-teal)" }}>{x.type}</td>
              <td style={{ font: "400 12px Inter", color: "var(--rt-fg-2)" }}>{x.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ font: '500 10px "IBM Plex Mono"', color: "var(--rt-fog-dim)", letterSpacing: "0.08em", marginBottom: 6 }}>
        ACCOUNTS · {ac.length}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
        {ac.map((x) => (
          <span
            key={x}
            style={{
              font: '500 11px "IBM Plex Mono"',
              color: "var(--rt-fg-2)",
              background: "var(--rt-slate-3)",
              border: "1px solid var(--rt-slate-line)",
              borderRadius: 4,
              padding: "4px 8px"
            }}
          >
            {x}
          </span>
        ))}
      </div>

      <div style={{ font: '500 10px "IBM Plex Mono"', color: "var(--rt-fog-dim)", letterSpacing: "0.08em", marginBottom: 6 }}>
        HOOKS · {ix.hooks.length}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {ix.hooks.length === 0 && <span style={{ font: "400 11px Inter", color: "var(--rt-fog-dim)" }}>No harness hooks fire on this instruction.</span>}
        {ix.hooks.map((h) => (
          <span key={h} className="ad-hook ad-hook--lg">
            {h}
          </span>
        ))}
      </div>
    </div>
  );
}

function InstructionsTab() {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = INSTRUCTIONS.find((i) => i.id === openId) ?? null;
  return (
    <div className="card" style={{ padding: 22 }}>
      <SectionHead
        kicker="INSTRUCTIONS"
        title={`Entry points · ${INSTRUCTIONS.length} simulated`}
        sub="Every instruction Riptide can issue against this protocol, and which harness hooks it triggers."
        onEdit={() => {}}
      />
      <div style={{ display: "grid", gridTemplateColumns: open ? "1.2fr 1fr" : "1fr", gap: 14 }}>
        <div style={{ border: "1px solid var(--rt-slate-line)", borderRadius: 6, overflow: "hidden" }}>
          <div className="ad-list-head">
            <span style={{ flex: 1 }}>NAME</span>
            <span style={{ width: 60 }}>ACCTS</span>
            <span style={{ width: 50 }}>ARGS</span>
            <span style={{ width: 220 }}>HOOKS</span>
          </div>
          {INSTRUCTIONS.map((ix) => (
            <button
              key={ix.id}
              onClick={() => setOpenId(ix.id === openId ? null : ix.id)}
              className={`ad-list-row${ix.id === openId ? " ad-list-row--active" : ""}`}
            >
              <span style={{ flex: 1, font: '500 13px "IBM Plex Mono"', color: "var(--rt-off-white)" }}>{ix.name}</span>
              <span style={{ width: 60, font: '500 12px "IBM Plex Mono"', color: "var(--rt-fg-2)" }}>{ix.accts}</span>
              <span style={{ width: 50, font: '500 12px "IBM Plex Mono"', color: "var(--rt-fg-2)" }}>{ix.args}</span>
              <span style={{ width: 220, display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
                {ix.hooks.length === 0 && <span style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)" }}>—</span>}
                {ix.hooks.map((h) => (
                  <span key={h} className="ad-hook">
                    {h}
                  </span>
                ))}
              </span>
            </button>
          ))}
        </div>

        {open && <InstructionDetail ix={open} />}
      </div>
    </div>
  );
}

interface SemanticSection { id: string; title: string; summary: string; code: string }

const SEMANTIC_SECTIONS: SemanticSection[] = [
  {
    id: "oracle",
    title: "Oracle assumptions",
    summary:
      "Riptide reads price from a single Pyth feed per reserve. We treat any update older than 60 slots as stale and skip the borrow/liquidate path; deviations greater than 5% within a slot are clamped before being passed to the protocol.",
    code: `oracle:
  source: pyth
  staleness_slots: 60
  max_deviation_pct: 5.0
  on_stale: skip_priced_actions`
  },
  {
    id: "fee",
    title: "Fee model",
    summary:
      "Borrow interest fees and liquidation bonuses are the two fee surfaces. Borrow fee is a 10% take-rate on accrued interest. Liquidation bonus is a flat 5% of seized collateral, with a 0.5% protocol cut.",
    code: `fees:
  borrow_take_rate: 0.10
  liquidation_bonus_pct: 5.0
  liquidation_protocol_cut: 0.5`
  },
  {
    id: "interest",
    title: "Interest model",
    summary:
      "Two-slope kink curve. Below 80% utilization, rate scales from 1% to 8% APY linearly. Above 80%, rate scales from 8% to 250% APY by 100% utilization to discourage running the pool dry.",
    code: `interest:
  curve: kink
  base_apy: 0.01
  optimal_apy: 0.08
  max_apy: 2.50
  optimal_utilization: 0.80`
  },
  {
    id: "liq",
    title: "Liquidation rules",
    summary:
      "A position is liquidatable when health factor (collateral × LTV / debt) drops below 1.0. Liquidators may seize up to 50% of collateral per call. Multiple unhealthy positions are processed in increasing health-factor order.",
    code: `liquidation:
  health_threshold: 1.0
  close_factor: 0.50
  ordering: health_ascending
  max_per_slot: 8`
  },
  {
    id: "state",
    title: "State transitions",
    summary:
      "The engine operates on a discrete slot clock. Each slot ticks: accrue interest → process pending instructions → re-check invariants. There is no intra-slot ordering across users; all instructions in the same slot see the same starting state.",
    code: `tick:
  - accrue_interest
  - process_instructions
  - check_invariants
intra_slot_ordering: indeterminate`
  },
  {
    id: "bounds",
    title: "Bounds & limits",
    summary:
      "All decimal math uses fixed-point with 9 decimals. Pool size is capped at u128 shares. Borrow caps default to 80% of supply per reserve; per-user position size is uncapped.",
    code: `precision: 9_decimals
limits:
  pool_shares_max: u128::MAX
  reserve_borrow_cap_pct: 0.80
  user_position_max: unbounded`
  }
];

function SemanticsTab() {
  const [openIds, setOpenIds] = useState<Set<string>>(new Set(["oracle"]));
  const toggle = (id: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  return (
    <div>
      <div className="card" style={{ padding: 22, marginBottom: 12 }}>
        <Kicker style={{ marginBottom: 4 }}>SEMANTICS</Kicker>
        <div style={{ font: "600 16px Inter", color: "var(--rt-off-white)", marginBottom: 4 }}>Economic model</div>
        <div style={{ font: "400 12px Inter", color: "var(--rt-fg-2)" }}>
          The assumptions Riptide is making about your protocol's behavior. If any of these is wrong,
          your simulation evidence is wrong — start here when results surprise you.
        </div>
      </div>

      {SEMANTIC_SECTIONS.map((s) => {
        const open = openIds.has(s.id);
        return (
          <div key={s.id} className="card" style={{ padding: 0, marginBottom: 8, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: 18 }}>
              <button
                onClick={() => toggle(s.id)}
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                  marginTop: 2,
                  color: "var(--rt-fog-dim)",
                  transform: open ? "rotate(90deg)" : "rotate(0)",
                  transition: "transform 120ms"
                }}
              >
                <Icon name="chevron" size={12} />
              </button>
              <div style={{ flex: 1 }}>
                <div style={{ font: "600 14px Inter", color: "var(--rt-off-white)", marginBottom: 6 }}>{s.title}</div>
                <div style={{ font: "400 13px/1.6 Inter", color: "var(--rt-fg-2)" }}>{s.summary}</div>
              </div>
              <button className="btn btn--ghost btn--sm">
                <Icon name="sparkles" size={12} />
                Edit with agent
              </button>
            </div>
            {open && (
              <pre
                style={{
                  margin: 0,
                  padding: "14px 18px",
                  background: "var(--rt-slate-2)",
                  borderTop: "1px solid var(--rt-slate-line)",
                  font: '400 12px/1.6 "IBM Plex Mono"',
                  color: "var(--rt-fg-2)",
                  overflow: "auto"
                }}
              >
                {s.code}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

function HarnessTab() {
  return (
    <div className="card" style={{ padding: 22 }}>
      <SectionHead
        kicker="HARNESS"
        title="Test setup"
        sub="How Riptide stages each simulation slot — fixtures, clock, mocks."
        onEdit={() => {}}
      />

      <div style={{ font: '500 10px "IBM Plex Mono"', color: "var(--rt-fog-dim)", letterSpacing: "0.08em", marginBottom: 6 }}>
        FIXTURES · 4 seeded
      </div>
      <table className="ptable" style={{ marginBottom: 18 }}>
        <thead>
          <tr>
            <th>account</th>
            <th>kind</th>
            <th>initial state</th>
          </tr>
        </thead>
        <tbody>
          <tr><td>pool/main</td><td>PDA</td><td>1 reserve seeded with 10 M USDC</td></tr>
          <tr><td>oracle/usdc</td><td>Pyth feed</td><td>price=1.00, conf=0.001</td></tr>
          <tr><td>oracle/sol</td><td>Pyth feed</td><td>price=145.0, conf=0.5</td></tr>
          <tr><td>fee_vault</td><td>Token</td><td>balance=0</td></tr>
        </tbody>
      </table>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 18 }}>
        <div style={{ background: "var(--rt-slate-2)", border: "1px solid var(--rt-slate-line)", borderRadius: 6, padding: 14 }}>
          <div style={{ font: '500 10px "IBM Plex Mono"', color: "var(--rt-fog-dim)", letterSpacing: "0.08em", marginBottom: 8 }}>
            DETERMINISTIC CLOCK
          </div>
          <pre style={{ margin: 0, font: '400 12px/1.6 "IBM Plex Mono"', color: "var(--rt-fg-2)" }}>
{`slot_ms: 400
start_slot: 250_000_000
seed: 0xdeadbeef`}
          </pre>
        </div>
        <div style={{ background: "var(--rt-slate-2)", border: "1px solid var(--rt-slate-line)", borderRadius: 6, padding: 14 }}>
          <div style={{ font: '500 10px "IBM Plex Mono"', color: "var(--rt-fog-dim)", letterSpacing: "0.08em", marginBottom: 8 }}>
            RPC MOCKING
          </div>
          <pre style={{ margin: 0, font: '400 12px/1.6 "IBM Plex Mono"', color: "var(--rt-fg-2)" }}>
{`get_account: replayed
sendTransaction: simulated
getRecentBlockhash: deterministic`}
          </pre>
        </div>
      </div>

      <div style={{ font: '500 10px "IBM Plex Mono"', color: "var(--rt-fog-dim)", letterSpacing: "0.08em", marginBottom: 6 }}>
        SEEDING RULES
      </div>
      <table className="ptable">
        <thead>
          <tr>
            <th>rule</th>
            <th>value</th>
          </tr>
        </thead>
        <tbody>
          <tr><td>persona token funding</td><td>10× declared trade size</td></tr>
          <tr><td>oracle drift</td><td>per-scenario; default ±0%</td></tr>
          <tr><td>compute budget</td><td>1.4 M units / tx</td></tr>
          <tr><td>signature verification</td><td>skipped (sim-only)</td></tr>
        </tbody>
      </table>
    </div>
  );
}

function ProbeTab() {
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(true);
  const run = () => {
    setRunning(true);
    setDone(false);
    setTimeout(() => {
      setRunning(false);
      setDone(true);
    }, 1400);
  };
  const checks = [
    { label: "BPF binary present", dot: "pass", detail: "target/deploy/lending.so · 412 KB" },
    { label: "Program ID matches manifest", dot: "pass", detail: "LendF1Vr…aN5oM2J" },
    { label: "Toolchain compatible", dot: "pass", detail: "solana-cli 1.18.26 · rustc 1.76.0" },
    { label: "Account map loadable", dot: "pass", detail: "12/12 PDAs resolved" },
    { label: "Instruction map executable", dot: "pass", detail: "10/10 ix verified" },
    { label: "Oracle feeds reachable", dot: "queued", detail: "Pyth devnet · 2 feeds OK · 1 stale" },
    { label: "Harness fixture build", dot: "pass", detail: "4 fixtures · seed 0xdeadbeef" }
  ];
  return (
    <div className="card" style={{ padding: 22 }}>
      <SectionHead
        kicker="PROBE"
        title="Adapter environment check"
        sub="Sanity check the build, toolchain, and external dependencies."
        right={
          <button className="btn btn--primary btn--sm" onClick={run} disabled={running}>
            <Icon name={running ? "refresh" : "cpu"} size={12} />
            {running ? "Probing…" : "Test now"}
          </button>
        }
      />

      {done && (
        <div style={{ border: "1px solid var(--rt-slate-line)", borderRadius: 6, overflow: "hidden" }}>
          {checks.map((c, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 14px",
                borderBottom: i === checks.length - 1 ? "none" : "1px solid var(--rt-slate-line)",
                background: i % 2 ? "var(--rt-slate-2)" : "transparent"
              }}
            >
              <span className={`dot dot--${c.dot}`} />
              <span style={{ flex: 1, font: "500 13px Inter", color: "var(--rt-off-white)" }}>{c.label}</span>
              <span style={{ font: '400 11px "IBM Plex Mono"', color: "var(--rt-fog-dim)" }}>{c.detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AdapterEmpty({ onNavigate }: { onNavigate: (id: PageId) => void }) {
  return (
    <div className="card" style={{ padding: 60, textAlign: "center" }}>
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 56,
          height: 56,
          borderRadius: 12,
          background: "var(--rt-slate-2)",
          marginBottom: 18,
          color: "var(--rt-fog-dim)"
        }}
      >
        <Icon name="cpu" size={26} />
      </div>
      <div style={{ font: "600 18px Inter", color: "var(--rt-off-white)", marginBottom: 6 }}>Adapter not configured</div>
      <div style={{ font: "400 13px Inter", color: "var(--rt-fg-2)", maxWidth: 460, margin: "0 auto 20px" }}>
        Riptide needs a protocol adapter before it can simulate. Start in Config handoff — your coding
        agent will read your program and generate the manifest, account map, and instruction map.
      </div>
      <button className="btn btn--primary" onClick={() => onNavigate("handoff")}>
        <Icon name="handoff" size={13} />
        Start in Config handoff
      </button>
    </div>
  );
}

type AdapterTab = "manifest" | "accounts" | "instructions" | "semantics" | "harness" | "probe";

interface AdapterPageProps {
  populated: boolean;
  onNavigate: (id: PageId) => void;
}

export function AdapterPage({ populated, onNavigate }: AdapterPageProps) {
  const [tab, setTab] = useState<AdapterTab>("manifest");
  if (!populated) {
    return (
      <div>
        <PageLabel>ADAPTER</PageLabel>
        <AdapterEmpty onNavigate={onNavigate} />
      </div>
    );
  }
  return (
    <div>
      <PageLabel>ADAPTER</PageLabel>
      <ProtocolStrip />
      <ValidationBanner />
      <TabStrip
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "manifest", label: "Manifest" },
          { id: "accounts", label: "Accounts", count: ACCOUNTS.length },
          { id: "instructions", label: "Instructions", count: INSTRUCTIONS.length },
          { id: "semantics", label: "Semantics", count: SEMANTIC_SECTIONS.length },
          { id: "harness", label: "Harness" },
          { id: "probe", label: "Probe" }
        ]}
      />
      {tab === "manifest" && <ManifestTab />}
      {tab === "accounts" && <AccountsTab />}
      {tab === "instructions" && <InstructionsTab />}
      {tab === "semantics" && <SemanticsTab />}
      {tab === "harness" && <HarnessTab />}
      {tab === "probe" && <ProbeTab />}
    </div>
  );
}
