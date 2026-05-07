import type { CSSProperties, ReactElement } from "react";

export type IconName =
  | "home" | "grid" | "handoff" | "users" | "plug" | "play" | "shield"
  | "queue" | "file" | "book" | "plus" | "search" | "settings" | "sun"
  | "moon" | "book2" | "chevron" | "chevronDown" | "x" | "check"
  | "external" | "copy" | "send" | "paperclip" | "stop" | "folder"
  | "terminal" | "edit" | "eye" | "refresh" | "database" | "download"
  | "sparkles" | "cpu" | "code" | "flame" | "target" | "coin" | "tx"
  | "activity" | "flag" | "dot" | "wallet" | "branch" | "link" | "gem" | "cursorArrow" | "terminalSquare" | "waveform";

interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
  style?: CSSProperties;
}

const PATHS: Record<IconName, ReactElement> = {
  home: <><path d="M3 12l9-9 9 9"/><path d="M5 10v10h14V10"/></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
  handoff: <><path d="M4 12h12"/><path d="M12 6l6 6-6 6"/><path d="M20 4v16"/></>,
  users: <><circle cx="9" cy="8" r="3"/><path d="M3 20c0-3 3-5 6-5s6 2 6 5"/><circle cx="17" cy="9" r="2.5"/><path d="M14 19c0-2.5 1.5-4 3.5-4s3.5 1.5 3.5 4"/></>,
  plug: <><path d="M9 2v6"/><path d="M15 2v6"/><path d="M7 8h10v4a5 5 0 0 1-10 0V8z"/><path d="M12 17v5"/></>,
  play: <><polygon points="6 4 20 12 6 20 6 4"/></>,
  shield: <><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/></>,
  queue: <><rect x="3" y="5" width="18" height="3" rx="1"/><rect x="3" y="10.5" width="18" height="3" rx="1"/><rect x="3" y="16" width="18" height="3" rx="1"/></>,
  file: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></>,
  book: <><path d="M5 4h10a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H5z"/><path d="M5 4v13"/></>,
  plus: <><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></>,
  search: <><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/></>,
  moon: <><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></>,
  book2: <><path d="M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2z"/><path d="M4 17a2 2 0 0 1 2-2h13"/></>,
  chevron: <><polyline points="9 6 15 12 9 18"/></>,
  chevronDown: <><polyline points="6 9 12 15 18 9"/></>,
  x: <><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></>,
  check: <><polyline points="5 12 10 17 19 7"/></>,
  external: <><path d="M14 4h6v6"/><path d="M20 4l-8 8"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></>,
  send: <><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></>,
  paperclip: <><path d="M20 12l-8.5 8.5a4 4 0 0 1-5.7-5.7L13 7a3 3 0 0 1 4.2 4.2L9.9 18.5a2 2 0 0 1-2.8-2.8l6.3-6.3"/></>,
  stop: <><rect x="6" y="6" width="12" height="12" rx="1"/></>,
  folder: <><path d="M4 5a2 2 0 0 1 2-2h4l2 3h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/></>,
  terminal: <><polyline points="5 8 9 12 5 16"/><line x1="12" y1="16" x2="19" y2="16"/></>,
  edit: <><path d="M16 3l5 5-12 12H4v-5z"/></>,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></>,
  refresh: <><polyline points="20 5 20 10 15 10"/><polyline points="4 19 4 14 9 14"/><path d="M20 10a8 8 0 0 0-14-3l-2 3"/><path d="M4 14a8 8 0 0 0 14 3l2-3"/></>,
  database: <><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></>,
  download: <><path d="M12 4v12"/><polyline points="7 11 12 16 17 11"/><line x1="4" y1="20" x2="20" y2="20"/></>,
  sparkles: <><path d="M12 3v3"/><path d="M12 18v3"/><path d="M4.5 7.5l2 2"/><path d="M17.5 14.5l2 2"/><path d="M3 12h3"/><path d="M18 12h3"/><path d="M4.5 16.5l2-2"/><path d="M17.5 9.5l2-2"/></>,
  cpu: <><rect x="6" y="6" width="12" height="12" rx="1"/><rect x="9" y="9" width="6" height="6"/><line x1="2" y1="9" x2="6" y2="9"/><line x1="2" y1="15" x2="6" y2="15"/><line x1="18" y1="9" x2="22" y2="9"/><line x1="18" y1="15" x2="22" y2="15"/><line x1="9" y1="2" x2="9" y2="6"/><line x1="15" y1="2" x2="15" y2="6"/><line x1="9" y1="18" x2="9" y2="22"/><line x1="15" y1="18" x2="15" y2="22"/></>,
  code: <><polyline points="9 7 4 12 9 17"/><polyline points="15 7 20 12 15 17"/></>,
  flame: <><path d="M12 22c4 0 7-3 7-7 0-4-3-6-4-9-3 1-7 5-7 9 0 4 0 7 4 7z"/><path d="M12 22c-2 0-3-2-3-4 0-1 1-3 2-4 0 2 1 3 2 3 0 2 0 5-1 5z"/></>,
  target: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></>,
  coin: <><circle cx="12" cy="12" r="9"/><path d="M12 7v10"/><path d="M9 9h4a2 2 0 0 1 0 4H9h5a2 2 0 0 1 0 4H9"/></>,
  tx: <><polyline points="3 7 8 7 11 4"/><polyline points="21 17 16 17 13 20"/><line x1="3" y1="7" x2="21" y2="7"/><line x1="3" y1="17" x2="21" y2="17"/></>,
  activity: <><polyline points="3 12 7 12 10 4 14 20 17 12 21 12"/></>,
  flag: <><path d="M5 21V4"/><path d="M5 4h12l-3 4 3 4H5"/></>,
  dot: <><circle cx="12" cy="12" r="2"/></>,
  wallet: <><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7H5a2 2 0 0 1 0-4h12V5a1 1 0 0 0-1-1H5a2 2 0 0 0-2 2z"/><circle cx="17" cy="13" r="1"/></>,
  branch: <><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10"/><path d="M18 9c0 4-6 4-6 8"/></>,
  link: <><path d="M10 14a4 4 0 0 1 0-5l3-3a4 4 0 1 1 6 6l-1.5 1.5"/><path d="M14 10a4 4 0 0 1 0 5l-3 3a4 4 0 1 1-6-6L6.5 10.5"/></>,
  gem: <><path d="M6 3h12l4 6-10 12L2 9z"/><path d="M11 3 8 9 12 21"/><path d="M13 3 16 9 12 21"/><path d="M2 9h20"/></>,
  cursorArrow: <><path d="M3 3l7.5 18 2.5-7.5 7.5-2.5z"/></>,
  terminalSquare: <><rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="7 9 10 12 7 15"/><line x1="13" y1="15" x2="17" y2="15"/></>,
  waveform: <><line x1="5" y1="9" x2="5" y2="15"/><line x1="9" y1="6" x2="9" y2="18"/><line x1="13" y1="9" x2="13" y2="15"/><line x1="17" y1="11" x2="17" y2="13"/><line x1="21" y1="9" x2="21" y2="15"/></>
};

export function Icon({ name, size = 16, color = "currentColor", strokeWidth = 1.5, style }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      {PATHS[name]}
    </svg>
  );
}
