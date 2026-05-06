interface StackedBarsProps {
  data: { pass: number; fail: number }[];
  w?: number;
  h?: number;
  gap?: number;
}

export function StackedBars({ data, w = 280, h = 80, gap = 4 }: StackedBarsProps) {
  const max = Math.max(...data.map((d) => d.pass + d.fail), 1);
  const bw = (w - gap * (data.length - 1)) / data.length;
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      {data.map((d, i) => {
        const x = i * (bw + gap);
        const total = d.pass + d.fail;
        const th = (total / max) * (h - 4);
        const fh = (d.fail / max) * (h - 4);
        const ph = (d.pass / max) * (h - 4);
        return (
          <g key={i}>
            {fh > 0 && <rect x={x} y={h - th} width={bw} height={fh} rx="1" fill="#EF4444" opacity="0.85" />}
            {ph > 0 && <rect x={x} y={h - th + fh} width={bw} height={ph} rx="1" fill="#22C55E" opacity="0.85" />}
          </g>
        );
      })}
    </svg>
  );
}

interface DonutProps {
  pass?: number;
  fail?: number;
  inconclusive?: number;
  size?: number;
}

export function Donut({ pass = 64, fail = 12, inconclusive = 6, size = 130 }: DonutProps) {
  const total = pass + fail + inconclusive;
  const r = size / 2 - 12;
  const c = 2 * Math.PI * r;
  const segs = [
    { v: pass, color: "#22C55E" },
    { v: fail, color: "#EF4444" },
    { v: inconclusive, color: "#7A8A99" }
  ];
  let off = 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <svg width={size} height={size}>
        <g transform={`translate(${size / 2} ${size / 2}) rotate(-90)`}>
          <circle r={r} fill="none" stroke="#1E2A38" strokeWidth="10" />
          {segs.map((s, i) => {
            const len = (s.v / total) * c;
            const dash = `${len} ${c - len}`;
            const el = (
              <circle
                key={i}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth="10"
                strokeDasharray={dash}
                strokeDashoffset={-off}
              />
            );
            off += len;
            return el;
          })}
        </g>
        <text x="50%" y="50%" textAnchor="middle" dy="0.32em" fill="#E6EEF2" fontFamily="IBM Plex Mono" fontSize="18" fontWeight="500">{pass}</text>
        <text x="50%" y="62%" textAnchor="middle" fill="#7A8A99" fontFamily="IBM Plex Mono" fontSize="9">PASS</text>
      </svg>
    </div>
  );
}

interface LineChartProps {
  data: number[];
  w?: number;
  h?: number;
  color?: string;
}

export function LineChart({ data, w = 280, h = 80, color = "#14B8B6" }: LineChartProps) {
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const span = max - min || 1;
  const dx = w / (data.length - 1);
  const pts = data.map((v, i) => [i * dx, h - 4 - ((v - min) / span) * (h - 8)] as const);
  const path = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const area = path + ` L${w} ${h} L0 ${h} Z`;
  const last = pts[pts.length - 1];
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <defs>
        <linearGradient id="lineFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#lineFill)" />
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" />
      {last && <circle cx={last[0]} cy={last[1]} r="2.5" fill={color} />}
    </svg>
  );
}
