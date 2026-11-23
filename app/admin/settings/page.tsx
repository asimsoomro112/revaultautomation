import SettingsSection from "../components/SettingsSection";
import { navLinkFor } from "../components/navLinks";
import styles from "../styles.module.css";

/** /admin/settings — bot settings on their own page. */
export default function AdminSettingsPage() {
  const meta = navLinkFor("/admin/settings");
  return (
    <>
      <div className={styles.pageHead}>
        <h1 className={styles.pageTitle}>{meta?.label ?? "Settings"}</h1>
        <p className={styles.pageDesc}>{meta?.blurb ?? ""}</p>
      </div>
      <SettingsSection />
    </>
  );
}
