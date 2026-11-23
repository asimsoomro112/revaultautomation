import BannedSellers from "../components/BannedSellers";
import { navLinkFor } from "../components/navLinks";
import styles from "../styles.module.css";

/** /admin/banned — the banned sellers list on its own page. */
export default function AdminBannedPage() {
  const meta = navLinkFor("/admin/banned");
  return (
    <>
      <div className={styles.pageHead}>
        <h1 className={styles.pageTitle}>{meta?.label ?? "Banned"}</h1>
        <p className={styles.pageDesc}>{meta?.blurb ?? ""}</p>
      </div>
      <BannedSellers />
    </>
  );
}
