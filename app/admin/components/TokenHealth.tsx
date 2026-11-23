"use client";

import { useCallback, useEffect, useState } from "react";
import { adminFetch, post, ApiError, type TokenHealthInfo } from "./api";
import styles from "../styles.module.css";

function badgeClass(health: string): string {
  const key = `badge${health}` as keyof typeof styles;
  return `${styles.badge} ${styles[key] ?? ""}`;
}

export default function TokenHealth() {
  const [health, setHealth] = useState<TokenHealthInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newToken, setNewToken] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      setHealth(await adminFetch<TokenHealthInfo>("/token-health"));
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status}: ${e.message}` : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function refresh() {
    if (!window.confirm("Refresh the Instagram long-lived token now?")) return;
    setBusy(true);
    setError(null);
    try {
      await post<{ ok: boolean }>("/token-refresh", {});
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status}: ${e.message}` : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!newToken.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await post<{ ok: boolean }>("/token-save", { token: newToken.trim() });
      setNewToken("");
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status}: ${e.message}` : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>Token health</h2>
      {error && <div className={styles.alert}>{error}</div>}
      {health && (
        <div className={styles.healthRow}>
          <span className={badgeClass(health.health)}>{health.health.toUpperCase()}</span>
          <span>
            Expires:{" "}
            <strong>
              {health.expires_at ? new Date(health.expires_at).toLocaleString() : "—"}
            </strong>
          </span>
          <span>
            Days left:{" "}
            <strong>
              {health.days_left == null ? "—" : Math.floor(health.days_left)}
            </strong>
          </span>
          {health.ig_user_id && <span className={styles.muted}>IG user {health.ig_user_id}</span>}
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={refresh} disabled={busy}>
            {busy ? "Refreshing…" : "Refresh now"}
          </button>
        </div>
      )}
      {!health && !error && <div className={styles.muted}>Loading…</div>}
      
      <div style={{ marginTop: 20, display: "flex", gap: 10, alignItems: "center" }}>
        <input 
          type="text" 
          placeholder="Paste new Instagram token here..." 
          value={newToken} 
          onChange={(e) => setNewToken(e.target.value)}
          className={styles.textarea}
          style={{ minHeight: "unset", padding: "10px 14px", height: 40, flex: 1 }}
        />
        <button 
          className={`${styles.btn} ${styles.btnApprove}`} 
          onClick={save} 
          disabled={busy || !newToken.trim()}
          style={{ height: 40 }}
        >
          {busy ? "Saving..." : "Save Token"}
        </button>
      </div>
    </section>
  );
}
