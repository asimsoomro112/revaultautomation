import QuotaGauge from "../components/QuotaGauge";
import { navLinkFor } from "../components/navLinks";
import styles from "../styles.module.css";

/** /admin/quota — Instagram API usage on its own page. */
export default function AdminQuotaPage() {
  const meta = navLinkFor("/admin/quota");
  return (
    <>
      <div className={styles.pageHead}>
        <h1 className={styles.pageTitle}>{meta?.label ?? "Quota"}</h1>
        <p className={styles.pageDesc}>{meta?.blurb ?? ""}</p>
      </div>
      <QuotaGauge />
    </>
  );
}
