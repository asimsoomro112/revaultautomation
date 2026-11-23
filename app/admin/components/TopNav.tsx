"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_LINKS } from "./navLinks";
import { ICONS } from "./navIcons";
import styles from "../styles.module.css";

/**
 * Desktop top navigation — the same nine admin pages as the bottom bar,
 * in a matching liquid-glass pill under the header. Hidden on mobile,
 * where the bottom pill is the nav. Without it, desktop would have no way
 * to move between pages after the single-page split (the bottom bar is
 * display:none at >=1024px).
 */
export default function TopNav() {
  const pathname = usePathname();
  return (
    <nav className={styles.topNav} aria-label="Admin pages">
      {NAV_LINKS.map((l) => {
        const active = pathname === l.href;
        return (
          <Link
            key={l.href}
            className={`${styles.topNavLink}${active ? ` ${styles.topNavLinkActive}` : ""}`}
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
