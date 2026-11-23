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

  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>
        Quota{" "}
        <button className={styles.btn} style={{ marginLeft: 12 }} onClick={load}>
          Refresh
        </button>
      </h2>
      {error && <div className={styles.alert}>{error}</div>}
      {quota && (
        <div className={styles.gaugeWrap}>
          <div>
            <div className={styles.gaugeLabel}>
              Today: <strong>{quota.today_count} / {quota.max}</strong> posts
            </div>
            <div className={styles.gaugeBar} style={{ marginTop: 6 }}>
              <div className={styles.gaugeFill} style={{ width: `${pct}%` }} />
            </div>
          </div>
          <div className={styles.gaugeLabel}>
            Meta content_publishing_limit:{" "}
            {quota.meta ? (
              <strong>
                {quota.meta.quota_usage} / {quota.meta.quota_total}
              </strong>
            ) : (
              <span className={styles.muted}>unavailable (best-effort)</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
