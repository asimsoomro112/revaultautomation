import KillSwitch from "../components/KillSwitch";
import { navLinkFor } from "../components/navLinks";
import styles from "../styles.module.css";

/** /admin/kill — the kill switch on its own page. */
export default function AdminKillPage() {
  const meta = navLinkFor("/admin/kill");
  return (
    <>
      <div className={styles.pageHead}>
        <h1 className={styles.pageTitle}>{meta?.label ?? "Kill switch"}</h1>
        <p className={styles.pageDesc}>{meta?.blurb ?? ""}</p>
      </div>
      <KillSwitch />
    </>
  );
}
