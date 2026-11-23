"use client";

import { useCallback, useEffect, useState } from "react";
import { adminFetch, post, ApiError, type SettingsInfo } from "./api";
import styles from "../styles.module.css";

export default function KillSwitch() {
  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSettings(await adminFetch<SettingsInfo>("/settings"));
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status}: ${e.message}` : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle() {
    if (!settings) return;
    const next = !settings.kill_switch;
    const ok = window.confirm(
      next
        ? "ENABLE the kill switch? All publishing will be parked immediately."
        : "DISABLE the kill switch? Publishing will resume.",
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ ok: boolean; kill_switch: boolean }>("/kill-switch", {
        on: next,
      });
      setSettings({ ...settings, kill_switch: res.kill_switch });
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status}: ${e.message}` : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>Kill switch</h2>
      {error && <div className={styles.alert}>{error}</div>}
      <div className={styles.killWrap}>
        <div>
          <div className={styles.killState}>
            {settings ? (settings.kill_switch ? "🛑 ENABLED" : "🟢 Disabled") : "…"}
          </div>
          {settings && (
            <div className={styles.muted} style={{ marginTop: 6 }}>
              Mode: {settings.publish_mode} · window {settings.posting_window.start}–
              {settings.posting_window.end} {settings.posting_window.tz}
            </div>
          )}
        </div>
        <button
          className={`${styles.killBtn} ${settings && !settings.kill_switch ? styles.off : ""}`}
          onClick={toggle}
          disabled={busy || !settings}
        >
          {busy ? "…" : settings?.kill_switch ? "DISABLE" : "ENABLE"}
        </button>
      </div>
    </section>
  );
}
