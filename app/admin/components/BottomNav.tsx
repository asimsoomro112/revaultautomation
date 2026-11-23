"use client";

import styles from "../styles.module.css";

const LINKS = [
  { href: "#queue", label: "Queue" },
  { href: "#quota", label: "Quota" },
  { href: "#token", label: "Token" },
  { href: "#kill", label: "Kill switch" },
  { href: "#log", label: "Log" },
] as const;

/**
 * Mobile bottom navigation for the admin dashboard. Anchor links jump to
 * the dashboard sections; hidden on desktop where the full page is visible.
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
