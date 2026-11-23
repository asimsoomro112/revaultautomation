"use client";

import { useState } from "react";
import { GoogleAuthProvider, signInWithPopup } from "firebase/auth";
import { getClientAuth } from "../firebase-client";
import styles from "../styles.module.css";

export default function SignInScreen({ configError }: { configError: string | null }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn() {
    setError(null);
    setBusy(true);
    try {
      await signInWithPopup(getClientAuth(), new GoogleAuthProvider());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.signinWrap}>
        <div className={styles.signinCard}>
          <h1>
            ReVault <span>Admin</span>
          </h1>
          <p>DM-to-Post review queue &amp; operations. Sign in with an authorized Google account.</p>
          {configError ? (
            <div className={styles.alert}>{configError}</div>
          ) : (
            <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={signIn} disabled={busy}>
              {busy ? "Signing in…" : "Sign in with Google"}
            </button>
          )}
          {error && <div className={styles.error}>{error}</div>}
        </div>
      </div>
    </div>
  );
}
