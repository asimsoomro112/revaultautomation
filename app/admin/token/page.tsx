import TokenHealth from "../components/TokenHealth";
import { navLinkFor } from "../components/navLinks";
import styles from "../styles.module.css";

/** /admin/token — bot token health on its own page. */
export default function AdminTokenPage() {
  const meta = navLinkFor("/admin/token");
  return (
    <>
      <div className={styles.pageHead}>
        <h1 className={styles.pageTitle}>{meta?.label ?? "Token"}</h1>
        <p className={styles.pageDesc}>{meta?.blurb ?? ""}</p>
      </div>
      <TokenHealth />
    </>
  );
}
