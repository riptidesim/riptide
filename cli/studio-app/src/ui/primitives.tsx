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
  iconImage?: string;
  title: string;
  body: ReactNode;
  ctaLabel?: string;
  onCta?: () => void;
  footer?: ReactNode;
}

export function EmptyState({ icon = "sparkles", iconImage, title, body, ctaLabel, onCta, footer }: EmptyStateProps) {
  return (
    <div className="empty">
      <div className="empty__icon">
        {iconImage ? <img src={iconImage} alt="" style={{ width: 28, height: 28 }} /> : <Icon name={icon} size={20} />}
      </div>
      <h3 className="empty__title">{title}</h3>
      <div className="empty__body">{body}</div>
      {ctaLabel && (
        <button className="btn btn--primary" onClick={onCta}>
          {ctaLabel}
        </button>
      )}
      {footer && <div className="empty__body">{footer}</div>}
    </div>
  );
}
