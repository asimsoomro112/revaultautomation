import ActivityFeed from "../components/ActivityFeed";
import { navLinkFor } from "../components/navLinks";
import styles from "../styles.module.css";

/** /admin/activity — the activity feed on its own page. */
export default function AdminActivityPage() {
  const meta = navLinkFor("/admin/activity");
  return (
    <>
      <div className={styles.pageHead}>
        <h1 className={styles.pageTitle}>{meta?.label ?? "Activity"}</h1>
        <p className={styles.pageDesc}>{meta?.blurb ?? ""}</p>
      </div>
      <ActivityFeed />
    </>
  );
}
