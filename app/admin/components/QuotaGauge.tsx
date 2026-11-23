"use client";

import { useCallback, useEffect, useState } from "react";
import { adminFetch, ApiError, type QuotaInfo } from "./api";
import styles from "../styles.module.css";

export default function QuotaGauge() {
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setQuota(await adminFetch<QuotaInfo>("/quota"));
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status}: ${e.message}` : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const pct =
    quota && quota.max > 0 ? Math.min(100, Math.round((quota.today_count / quota.max) * 100)) : 0;
  const metaPct =
    quota?.meta && quota.meta.quota_total > 0
      ? Math.min(100, Math.round((quota.meta.quota_usage / quota.meta.quota_total) * 100))
      : 0;
  // Ring geometry: r=48 → circumference ≈ 301.6. dashoffset draws the used share.
  const ringC = 2 * Math.PI * 48;

  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Quota</h2>
        <button className={styles.btn} onClick={load}>
          Refresh
        </button>
      </div>
      {error && <div className={styles.alert}>{error}</div>}
      {quota && (
        <div className={styles.gaugeWrap}>
          <div className={styles.ringRow}>
            <div className={styles.ringWrap}>
              <svg className={styles.ringSvg} width="112" height="112" viewBox="0 0 112 112" aria-hidden="true">
                <circle className={styles.ringTrack} cx="56" cy="56" r="48" />
                <circle
                  className={styles.ringFill}
                  cx="56"
                  cy="56"
                  r="48"
                  strokeDasharray={ringC}
                  strokeDashoffset={ringC * (1 - pct / 100)}
                />
              </svg>
              <div className={styles.ringCenter}>
                <span className={styles.ringPct}>{pct}%</span>
                <span className={styles.ringCaption}>used today</span>
              </div>
            </div>
            <div className={styles.ringSide}>
              <div className={styles.gaugeLabel}>
                Today: <strong>{quota.today_count} / {quota.max}</strong> posts
              </div>
              <div className={styles.gaugeLabel}>
                Meta content publishing limit:{" "}
                {quota.meta ? (
                  <strong>
                    {quota.meta.quota_usage} / {quota.meta.quota_total}
                  </strong>
                ) : (
                  <span className={styles.muted}>unavailable (best-effort)</span>
                )}
              </div>
              {quota.meta && (
                <div className={styles.gaugeBar}>
                  <div className={styles.gaugeFill} style={{ width: `${metaPct}%` }} />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
