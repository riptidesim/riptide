import type { CSSProperties, ReactNode } from "react";

import { Icon, type IconName } from "./Icon";

export type PillKind = "pass" | "fail" | "warn" | "info" | "running" | "queued" | "neutral";

interface PillProps {
  kind?: PillKind;
  children: ReactNode;
  dot?: boolean;
}

export function Pill({ kind = "neutral", children, dot }: PillProps) {
  return (
    <span className={`pill pill--${kind}`}>
      {dot && <span className={`dot dot--${kind}`} />}
      {children}
    </span>
  );
}

interface KickerProps {
  accent?: boolean;
  children: ReactNode;
  style?: CSSProperties;
}

export function Kicker({ accent, children, style }: KickerProps) {
  return (
    <div className={`kicker${accent ? " kicker--accent" : ""}`} style={style}>
      {children}
    </div>
  );
}

export function PageLabel({ children }: { children: ReactNode }) {
  return <h1 className="page-label">{children}</h1>;
}

interface EmptyStateProps {
  icon?: IconName;
  title: string;
  body: string;
  ctaLabel?: string;
  onCta?: () => void;
}

export function EmptyState({ icon = "sparkles", title, body, ctaLabel, onCta }: EmptyStateProps) {
  return (
    <div className="empty">
      <div className="empty__icon"><Icon name={icon} size={20} /></div>
      <h3 className="empty__title">{title}</h3>
      <p className="empty__body">{body}</p>
      {ctaLabel && (
        <button className="btn btn--primary btn--sm" onClick={onCta}>
          {ctaLabel}
        </button>
      )}
    </div>
  );
}
