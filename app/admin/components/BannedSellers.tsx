"use client";

import { useCallback, useEffect, useState } from "react";
import { adminFetch, ApiError, post, type BannedSeller } from "./api";
import styles from "../styles.module.css";

/** Same truncation the API uses for seller ids in the queue. */
function truncId(igsid: string): string {
  return igsid.length > 10 ? `${igsid.slice(0, 6)}…` : igsid;
}

/**
 * Banned sellers — the blocklist (GET /api/admin/sellers/banned) with an
 * Unban action per row. Unbanning deletes the blocklist entry and clears
 * the conversation's blocked flag, so the seller can submit again.
 */
export default function BannedSellers() {
  const [items, setItems] = useState<BannedSeller[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await adminFetch<{ items: BannedSeller[] }>("/sellers/banned");
      setItems(data.items);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status}: ${e.message}` : String(e));
    }
  }, []);

  useEffect(() => {
    // Mount fetch: load() only sets state after the async fetch resolves,
    // so there is no cascading render; the rule cannot see through the call.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function unban(igsid: string) {
    if (!window.confirm(`Unban seller ${truncId(igsid)}? They will be able to submit again.`)) {
      return;
    }
    setBusy(igsid);
    setError(null);
    try {
      await post(`/sellers/${igsid}/unban`, {});
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status}: ${e.message}` : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={styles.section} id="banned">
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>
          Banned sellers {items ? `(${items.length})` : ""}
        </h2>
        <button className={styles.btn} onClick={load}>
          Refresh
        </button>
      </div>
      {error && <div className={styles.alert}>{error}</div>}
      {items === null && !error && <div className={styles.muted}>Loading…</div>}
      {items !== null && items.length === 0 && (
        <div className={styles.empty}>No banned sellers.</div>
      )}
      {items !== null && items.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.logTable}>
            <thead>
              <tr>
                <th>Seller</th>
                <th>Reason</th>
                <th>Banned</th>
                <th>By</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.igsid}>
                  <td>{truncId(s.igsid)}</td>
                  <td>{s.reason || "—"}</td>
                  <td>{s.at ? new Date(s.at).toLocaleString() : "—"}</td>
                  <td>{s.by ?? "—"}</td>
                  <td>
                    <button
                      className={`${styles.btn} ${styles.btnPrimary}`}
                      disabled={busy !== null}
                      onClick={() => unban(s.igsid)}
                    >
                      {busy === s.igsid ? "…" : "Unban"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
