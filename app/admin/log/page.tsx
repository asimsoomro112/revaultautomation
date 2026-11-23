import PublishLog from "../components/PublishLog";
import { navLinkFor } from "../components/navLinks";
import styles from "../styles.module.css";

/** /admin/log — the publish log on its own page. */
export default function AdminLogPage() {
  const meta = navLinkFor("/admin/log");
  return (
    <>
      <div className={styles.pageHead}>
        <h1 className={styles.pageTitle}>{meta?.label ?? "Log"}</h1>
        <p className={styles.pageDesc}>{meta?.blurb ?? ""}</p>
      </div>
      <PublishLog />
    </>
  );
}
