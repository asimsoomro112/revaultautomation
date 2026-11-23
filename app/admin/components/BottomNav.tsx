"use client";

import type { ReactNode } from "react";
import styles from "../styles.module.css";

/**
 * Nav icons — inline SVG (Feather-style: 24×24, 2px stroke, round caps).
 * Vector, not raster: the image tool cannot output transparency, so PNG
 * icons would sit on visible squares over the dark bar. `currentColor`
 * lets each icon follow the link color (muted → accent on press).
 */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className={styles.bottomNavIcon}
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

const ICONS = {
  stats: (
    <Icon>
      <line x1="5" y1="20" x2="5" y2="12" />
      <line x1="11" y1="20" x2="11" y2="5" />
      <line x1="17" y1="20" x2="17" y2="9" />
      <line x1="3" y1="20" x2="21" y2="20" />
    </Icon>
  ),
  queue: (
    <Icon>
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </Icon>
  ),
  quota: (
    <Icon>
      <path d="M21.21 15.89A10 10 0 1 1 8 2.83" />
      <path d="M22 12A10 10 0 0 0 12 2v10z" />
    </Icon>
  ),
  token: (
    <Icon>
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </Icon>
  ),
  kill: (
    <Icon>
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
      <line x1="12" y1="2" x2="12" y2="12" />
    </Icon>
  ),
  log: (
    <Icon>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </Icon>
  ),
  settings: (
    <Icon>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Icon>
  ),
  activity: (
    <Icon>
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </Icon>
  ),
  banned: (
    <Icon>
      <circle cx="12" cy="12" r="10" />
      <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
    </Icon>
  ),
} as const;

type NavKey = keyof typeof ICONS;

const LINKS: Array<{ href: string; label: string; icon: NavKey }> = [
  { href: "#stats", label: "Stats", icon: "stats" },
  { href: "#queue", label: "Queue", icon: "queue" },
  { href: "#quota", label: "Quota", icon: "quota" },
  { href: "#token", label: "Token", icon: "token" },
  { href: "#kill", label: "Kill switch", icon: "kill" },
  { href: "#log", label: "Log", icon: "log" },
  { href: "#settings", label: "Settings", icon: "settings" },
  { href: "#activity", label: "Activity", icon: "activity" },
  { href: "#banned", label: "Banned", icon: "banned" },
];

/**
 * Mobile bottom navigation for the admin dashboard. Anchor links jump to
 * the dashboard sections; hidden on desktop where the full page is visible.
 * Nine links no longer fit one row, so the bar scrolls horizontally.
 */
export default function BottomNav() {
  return (
    <nav className={styles.bottomNav} aria-label="Dashboard sections">
      {LINKS.map((l) => (
        <a key={l.href} className={styles.bottomNavLink} href={l.href}>
          {ICONS[l.icon]}
          <span>{l.label}</span>
        </a>
      ))}
    </nav>
  );
}
