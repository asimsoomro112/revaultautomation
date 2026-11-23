"use client";

/**
 * /admin layout — shared chrome for every admin page.
 *
 * Firebase Google sign-in (client SDK) → onAuthStateChanged → every
 * /api/admin call carries `Authorization: Bearer <ID token>`. Signed-out
 * users see the sign-in screen; non-admin tokens get an "Access denied"
 * screen (the API returns 401/403). The gate lives here once, so each
 * page is just its section — no per-page auth copy. On navigation the
 * layout (and the auth state) is preserved; only the page swaps.
 */
import { useEffect, useState, type ReactNode } from "react";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { getClientAuth, getClientConfigError } from "./firebase-client";
import SignInScreen from "./components/SignInScreen";
import TopNav from "./components/TopNav";
import BottomNav from "./components/BottomNav";
import LogoMark from "../components/LogoMark";
import { adminFetch } from "./components/api";
import styles from "./styles.module.css";

type AuthPhase = "loading" | "signed-out" | "checking" | "denied" | "ready";

export default function AdminLayout({ children }: { children: ReactNode }) {
  const [configError] = useState<string | null>(() => getClientConfigError());
  const [phase, setPhase] = useState<AuthPhase>(
    configError ? "signed-out" : "loading",
  );
  const [user, setUser] = useState<User | null>(null);
  const [deniedMsg, setDeniedMsg] = useState<string>("");

  useEffect(() => {
    if (configError) return;
    const unsub = onAuthStateChanged(getClientAuth(), async (u) => {
      setUser(u);
      if (!u) {
        setPhase("signed-out");
        return;
      }
      setPhase("checking");
      try {
        // A cheap authed call proves the token carries admin rights.
        await adminFetch<{ kill_switch: boolean }>("/settings");
        setPhase("ready");
      } catch (e) {
        setDeniedMsg(e instanceof Error ? e.message : String(e));
        setPhase("denied");
      }
    });
    return unsub;
  }, [configError]);

  async function handleSignOut() {
    await signOut(getClientAuth());
  }

  if (phase === "loading" || phase === "checking") {
    return (
      <div className={styles.page}>
        <div className={styles.signinWrap}>
          <div className={styles.muted}>Loading…</div>
        </div>
      </div>
    );
  }

  if (phase === "signed-out") {
    return <SignInScreen configError={configError} />;
  }

  if (phase === "denied") {
    return (
      <div className={styles.page}>
        <div className={styles.signinWrap}>
          <div className={styles.signinCard}>
            <h1>
              ReVault <span>Admin</span>
            </h1>
            <div className={styles.alert}>
              Access denied — {user?.email ?? "this account"} is not an admin.
              <div className={styles.muted} style={{ marginTop: 8 }}>{deniedMsg}</div>
            </div>
            <button className={styles.btn} onClick={handleSignOut}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.logo}>
          <LogoMark size={28} className={styles.logoMark} />
          ReVault <span className={styles.logoAdmin}>Admin</span>
        </div>
        <div className={styles.userbox}>
          <span className={styles.userEmail}>{user?.email}</span>
          <button className={styles.btn} onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      </header>
      <TopNav />
      <main className={styles.main}>{children}</main>
      <BottomNav />
    </div>
  );
}
