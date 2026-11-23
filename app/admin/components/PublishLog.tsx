"use client";

import { useCallback, useEffect, useState } from "react";
import { adminFetch, ApiError, type PublishLogRow } from "./api";
import styles from "../styles.module.css";

function fmtLatency(s: number | null): string {
  if (s == null) return "—";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

export default function PublishLog() {
  const [rows, setRows] = useState<PublishLogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await adminFetch<{ items: PublishLogRow[] }>("/publish-log");
      setRows(data.items);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status}: ${e.message}` : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Publish log</h2>
        <button className={styles.btn} onClick={load}>
          Refresh
        </button>
      </div>
      {error && <div className={styles.alert}>{error}</div>}
      {rows === null && !error && <div className={styles.muted}>Loading…</div>}
      {rows !== null && rows.length === 0 && (
        <div className={styles.empty}>No published listings yet.</div>
      )}
      {rows !== null && rows.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.logTable}>
            <thead>
              <tr>
                <th>Time</th>
                <th>Permalink</th>
                <th>Seller</th>
                <th>Latency</th>
                <th>Attempts</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.published_at ? new Date(r.published_at).toLocaleString() : "—"}</td>
                  <td>
                    {r.permalink ? (
                      <a href={r.permalink} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{r.seller}</td>
                  <td>{fmtLatency(r.latency_s)}</td>
                  <td>{r.attempts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
