import QueueSection from "../components/QueueSection";
import { navLinkFor } from "../components/navLinks";
import styles from "../styles.module.css";

/** /admin/queue — the review queue on its own page. */
export default function AdminQueuePage() {
  const meta = navLinkFor("/admin/queue");
  return (
    <>
      <div className={styles.pageHead}>
        <h1 className={styles.pageTitle}>{meta?.label ?? "Queue"}</h1>
        <p className={styles.pageDesc}>{meta?.blurb ?? ""}</p>
      </div>
      <QueueSection />
    </>
  );
}
