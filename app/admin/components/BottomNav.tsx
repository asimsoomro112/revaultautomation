"use client";

import styles from "../styles.module.css";

const LINKS = [
  { href: "#stats", label: "Stats" },
  { href: "#queue", label: "Queue" },
  { href: "#quota", label: "Quota" },
  { href: "#token", label: "Token" },
  { href: "#kill", label: "Kill switch" },
  { href: "#log", label: "Log" },
  { href: "#settings", label: "Settings" },
  { href: "#activity", label: "Activity" },
  { href: "#banned", label: "Banned" },
] as const;

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
          {l.label}
        </a>
      ))}
    </nav>
  );
}
