"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_LINKS } from "./navLinks";
import { ICONS } from "./navIcons";
import styles from "../styles.module.css";

/**
 * Mobile bottom navigation for the admin dashboard. Links are routes now
 * (one page per section), not anchors — the old #activity / #banned
 * anchors pointed at ids that did not exist. Nine links no longer fit one
 * row, so the bar scrolls horizontally. The current page is marked with
 * aria-current plus an accent pill background, not colour alone.
 */
export default function BottomNav() {
  const pathname = usePathname();
  return (
    <nav className={styles.bottomNav} aria-label="Admin pages">
      {NAV_LINKS.map((l) => {
        const active = pathname === l.href;
        return (
          <Link
            key={l.href}
            className={`${styles.bottomNavLink}${active ? ` ${styles.bottomNavLinkActive}` : ""}`}
            href={l.href}
            aria-current={active ? "page" : undefined}
          >
            {ICONS[l.icon]}
            <span>{l.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
