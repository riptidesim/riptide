import { useState, type ReactNode } from "react";

interface StackedBarsProps {
  data: { pass: number; fail: number }[];
  labels?: string[];
  w?: number;
  h?: number;
  gap?: number;
}

export function StackedBars({ data, labels, w = 280, h = 80, gap = 4 }: StackedBarsProps) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...data.map((d) => d.pass + d.fail), 1);
  const bw = (w - gap * (data.length - 1)) / data.length;
  const active = hover !== null ? data[hover] : null;
  const activeLabel = hover !== null ? labels?.[hover] ?? `Bar ${hover + 1}` : null;

  return (
    <div style={{ position: "relative" }}>
      <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" onMouseLeave={() => setHover(null)}>
        {data.map((d, i) => {
          const x = i * (bw + gap);
          const total = d.pass + d.fail;
          const th = (total / max) * (h - 4);
          const fh = (d.fail / max) * (h - 4);
          const ph = (d.pass / max) * (h - 4);
          const dim = hover !== null && hover !== i;
          const opacity = dim ? 0.35 : 0.9;
          return (
            <g key={i} onMouseEnter={() => setHover(i)} style={{ cursor: "pointer" }}>
              {fh > 0 && <rect x={x} y={h - th} width={bw} height={fh} rx="1" fill="#EF4444" opacity={opacity} />}
              {ph > 0 && <rect x={x} y={h - th + fh} width={bw} height={ph} rx="1" fill="#22C55E" opacity={opacity} />}
              <rect x={x} y={0} width={bw} height={h} fill="transparent" />
            </g>
          );
        })}
      </svg>
      {active && hover !== null && (
        <div
          style={{
            position: "absolute",
            left: `${((hover + 0.5) / data.length) * 100}%`,
            top: -4,
            transform: "translate(-50%, -100%)",
            background: "#0A1620",
            border: "1px solid var(--rt-slate-line)",
            borderRadius: 4,
            padding: "6px 8px",
            font: '400 11px "IBM Plex Mono"',
            color: "var(--rt-off-white)",
            whiteSpace: "nowrap",
            pointerEvents: "none",
            zIndex: 1
          }}
        >
          {activeLabel && <div style={{ color: "var(--rt-fog-dim)", marginBottom: 2 }}>{activeLabel}</div>}
          <span style={{ color: "#22C55E" }}>{active.pass} pass</span>
          {" · "}
          <span style={{ color: "#EF4444" }}>{active.fail} fail</span>
        </div>
      )}
    </div>
  );
}

interface DonutProps {
  pass?: number;
  fail?: number;
  inconclusive?: number;
  size?: number;
  legend?: ReactNode;
}

export function Donut({ pass = 64, fail = 12, inconclusive = 6, size = 130, legend }: DonutProps) {
  const [hover, setHover] = useState<number | null>(null);
  const total = Math.max(pass + fail + inconclusive, 1);
  const r = size / 2 - 12;
  const c = 2 * Math.PI * r;
  const segs = [
    { v: pass, color: "#22C55E", label: "PASS" },
    { v: fail, color: "#EF4444", label: "FAIL" },
    { v: inconclusive, color: "#7A8A99", label: "INCONC" }
  ];
  const active = hover !== null ? segs[hover] : null;
  const centerValue = active ? active.v : pass;
  const centerLabel = active ? active.label : "PASS";
  let off = 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <svg width={size} height={size} onMouseLeave={() => setHover(null)}>
        <g transform={`translate(${size / 2} ${size / 2}) rotate(-90)`}>
          <circle r={r} fill="none" stroke="#1E2A38" strokeWidth="10" />
          {segs.map((s, i) => {
            const len = (s.v / total) * c;
            const dash = `${len} ${c - len}`;
            const isActive = hover === i;
            const opacity = hover === null || isActive ? 1 : 0.45;
            const el = (
              <circle
                key={i}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={isActive ? 12 : 10}
                strokeDasharray={dash}
                strokeDashoffset={-off}
                opacity={opacity}
                onMouseEnter={() => s.v > 0 && setHover(i)}
                style={{ cursor: s.v > 0 ? "pointer" : "default", transition: "stroke-width 120ms, opacity 120ms" }}
              />
            );
            off += len;
            return el;
          })}
        </g>
        <text x="50%" y="50%" textAnchor="middle" dy="0.32em" fill="#E6EEF2" fontFamily="IBM Plex Mono" fontSize="18" fontWeight="500">{centerValue}</text>
        <text x="50%" y="62%" textAnchor="middle" fill="#7A8A99" fontFamily="IBM Plex Mono" fontSize="9">{centerLabel}</text>
      </svg>
      {legend}
    </div>
  );
}

interface LineChartProps {
  data: number[];
  labels?: string[];
  w?: number;
  h?: number;
  color?: string;
}

interface HorizontalBarsProps {
  data: { label: string; value: number; color?: string }[];
  max?: number;
  labelWidth?: number;
}

export function HorizontalBars({ data, max, labelWidth = 88 }: HorizontalBarsProps) {
  const [hover, setHover] = useState<number | null>(null);
  const cap = max ?? Math.max(...data.map((d) => d.value), 1);
  return (
    <div style={{ display: "grid", gap: 6 }} onMouseLeave={() => setHover(null)}>
      {data.map((d, i) => {
        const pct = (d.value / cap) * 100;
        const dim = hover !== null && hover !== i;
        return (
          <div
            key={i}
            onMouseEnter={() => setHover(i)}
            title={`${d.label}: ${d.value}`}
            style={{
              display: "grid",
              gridTemplateColumns: `${labelWidth}px 1fr 36px`,
              alignItems: "center",
              gap: 8,
              font: '400 11px "IBM Plex Mono"',
              cursor: "default",
              opacity: dim ? 0.5 : 1,
              transition: "opacity 120ms"
            }}
          >
            <span style={{ color: "var(--rt-fog-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.label}</span>
            <div style={{ height: 8, background: "#1E2A38", borderRadius: 2, overflow: "hidden" }}>
              <div
                style={{
                  width: `${pct}%`,
                  height: "100%",
                  background: d.color ?? "#14B8B6",
                  filter: hover === i ? "brightness(1.2)" : "none",
                  transition: "filter 120ms"
                }}
              />
            </div>
            <span style={{ color: "var(--rt-off-white)", textAlign: "right" }}>{d.value}</span>
          </div>
        );
      })}
    </div>
  );
}

export function LineChart({ data, labels, w = 280, h = 80, color = "#14B8B6" }: LineChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const safe = data.length > 0 ? data : [0];
  const max = Math.max(...safe, 1);
  const min = Math.min(...safe, 0);
  const span = max - min || 1;
  const dx = safe.length > 1 ? w / (safe.length - 1) : 0;
  const pts = safe.map((v, i) => [i * dx, h - 4 - ((v - min) / span) * (h - 8)] as const);
  const path = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const area = path + ` L${w} ${h} L0 ${h} Z`;
  const last = pts[pts.length - 1];
  const activePt = hover !== null ? pts[hover] : null;
  const activeLabel = hover !== null ? labels?.[hover] : null;

  function handleMove(event: React.MouseEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, x / rect.width));
    const idx = Math.round(ratio * (safe.length - 1));
    setHover(idx);
  }

  return (
    <div style={{ position: "relative" }} onMouseMove={handleMove} onMouseLeave={() => setHover(null)}>
      <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="lineFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.25" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#lineFill)" />
        <path d={path} fill="none" stroke={color} strokeWidth="1.5" />
        {hover !== null && activePt && (
          <line x1={activePt[0]} y1={0} x2={activePt[0]} y2={h} stroke={color} strokeWidth="0.75" opacity="0.4" strokeDasharray="2 3" />
        )}
        {last && hover === null && <circle cx={last[0]} cy={last[1]} r="2.5" fill={color} />}
      </svg>
      {hover !== null && activePt && (
        <>
          <div
            style={{
              position: "absolute",
              left: `${(hover / Math.max(safe.length - 1, 1)) * 100}%`,
              top: `${(activePt[1] / h) * 100}%`,
              transform: "translate(-50%, -50%)",
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: color,
              boxShadow: `0 0 0 3px ${color}33`,
              pointerEvents: "none"
            }}
          />
          <div
            style={{
              position: "absolute",
              left: `${(hover / Math.max(safe.length - 1, 1)) * 100}%`,
              top: -4,
              transform: "translate(-50%, -100%)",
              background: "#0A1620",
              border: "1px solid var(--rt-slate-line)",
              borderRadius: 4,
              padding: "6px 8px",
              font: '400 11px "IBM Plex Mono"',
              color: "var(--rt-off-white)",
              whiteSpace: "nowrap",
              pointerEvents: "none",
              zIndex: 1
            }}
          >
            {activeLabel && <div style={{ color: "var(--rt-fog-dim)", marginBottom: 2 }}>{activeLabel}</div>}
            <span>{safe[hover]}</span>
          </div>
        </>
      )}
    </div>
  );
}
