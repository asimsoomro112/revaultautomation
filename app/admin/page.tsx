import Link from "next/link";
import StatsRow from "./components/StatsRow";
import { ICONS } from "./components/navIcons";
import { NAV_LINKS } from "./components/navLinks";
import styles from "./styles.module.css";

/**
 * /admin — dashboard home. Stats on top, then one card per section page.
 * The bottom bar (mobile) and the top bar (desktop) navigate the same
 * nine routes; the cards are the third way in, for the home page itself.
 */
export default function AdminHomePage() {
  return (
    <>
      <div className={styles.pageHead}>
        <h1 className={styles.pageTitle}>Dashboard</h1>
        <p className={styles.pageDesc}>
          Everything about the bot, at a glance. Open a section below, or use
          the navigation bar.
        </p>
      </div>
      <StatsRow />
      <nav className={styles.cardGrid} aria-label="Admin sections">
        {NAV_LINKS.filter((l) => l.href !== "/admin").map((l) => (
          <Link key={l.href} href={l.href} className={styles.navCard}>
            {ICONS[l.icon]}
            <span className={styles.navCardLabel}>{l.label}</span>
            <span className={styles.navCardBlurb}>{l.blurb}</span>
          </Link>
        ))}
      </nav>
    </>
  );
}
