interface Props {
  text?: string;
  tone?: "pass" | "fail" | "warn" | "info" | "neutral";
}

export function StatusPill({ text, tone }: Props) {
  if (!text) return null;
  const t = inferTone(text, tone);
  const cls = t === "neutral" ? "rt-pill" : `rt-pill rt-pill--${t}`;
  return <span className={cls}>{text.toUpperCase()}</span>;
}

function inferTone(text: string, hint?: Props["tone"]): NonNullable<Props["tone"]> {
  if (hint) return hint;
  const lower = text.toLowerCase();
  if (lower.includes("pass") || lower === "ok" || lower.includes("supported")) return "pass";
  if (
    lower.includes("fail") ||
    lower.includes("breach") ||
    lower.includes("error") ||
    lower.includes("missing")
  ) {
    return "fail";
  }
  if (lower.includes("warn") || lower.includes("partial") || lower.includes("setup")) return "warn";
  if (lower.includes("queued") || lower.includes("running") || lower.includes("info")) return "info";
  return "neutral";
}
