"use client";

import { useCallback, useEffect, useState } from "react";
import { adminFetch, post, ApiError, type QueueItem } from "./api";
import styles from "../styles.module.css";

function badgeClass(status: string): string {
  const key = `badge${status}` as keyof typeof styles;
  return `${styles.badge} ${styles[key] ?? ""}`;
}

function fmtPrice(pkr: number | null): string {
  return pkr == null ? "—" : `Rs ${pkr.toLocaleString("en-PK")}`;
}

function ListingCard({
  item,
  onChanged,
}: {
  item: QueueItem;
  onChanged: () => void;
}) {
  const [caption, setCaption] = useState(item.caption ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label);
    setErr(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError ? `${e.status}: ${e.message}` : String(e));
    } finally {
      setBusy(null);
    }
  }

  const ex = item.extracted;
  const mod = item.moderation;

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.cardId}>{item.id}</span>
        <span className={badgeClass(item.status)}>{item.status}</span>
      </div>

      <div className={styles.photos}>
        {item.photo_urls.filter(Boolean).map((u, i) => (
          <img key={i} src={u} alt={`photo ${i + 1}`} loading="lazy" />
        ))}
        {item.photo_urls.filter(Boolean).length === 0 && (
          <span className={styles.muted}>no preview URLs</span>
        )}
      </div>

      {ex && (
        <table className={styles.kvTable}>
          <tbody>
            <tr><td>Title</td><td>{ex.title}</td></tr>
            <tr><td>Category</td><td>{ex.category ?? "—"} · {ex.gender ?? "—"}</td></tr>
            <tr><td>Brand</td><td>{ex.brand ?? "—"}</td></tr>
            <tr><td>Color / Size</td><td>{ex.color ?? "—"} / {ex.size ?? "—"}</td></tr>
            <tr><td>Condition</td><td>{ex.condition ?? "—"}</td></tr>
            <tr><td>Price</td><td>{fmtPrice(ex.price_pkr)}</td></tr>
            <tr><td>City</td><td>{ex.city ?? "—"}</td></tr>
            {ex.defects.length > 0 && <tr><td>Defects</td><td>{ex.defects.join("; ")}</td></tr>}
            {item.missing.length > 0 && (
              <tr><td>Missing</td><td>{item.missing.join(", ")}</td></tr>
            )}
          </tbody>
        </table>
      )}

      {mod && (
        <div>
          <span className={badgeClass(mod.verdict)}>{mod.verdict}</span>
          {mod.reasons.length > 0 && (
            <ul className={styles.reasons}>
              {mod.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {item.publish.last_error && (
        <div className={styles.error}>Last error: {item.publish.last_error}</div>
      )}
      {item.publish.slot_at && (
        <div className={styles.muted}>Slot: {new Date(item.publish.slot_at).toLocaleString()}</div>
      )}

      <textarea
        className={styles.textarea}
        value={caption}
        onChange={(e) => setCaption(e.target.value)}
        placeholder="Caption (editable)"
      />

      <div className={styles.btnRow}>
        <button
          className={`${styles.btn} ${styles.btnApprove}`}
          disabled={busy !== null}
          onClick={() =>
            run("approve", () => post(`/listings/${item.id}/approve`, {}))
          }
        >
          {busy === "approve" ? "…" : "Approve"}
        </button>
        <button
          className={styles.btn}
          disabled={busy !== null}
          onClick={() =>
            run("caption", () => post(`/listings/${item.id}/caption`, { caption }))
          }
        >
          {busy === "caption" ? "…" : "Save caption"}
        </button>
        <button
          className={`${styles.btn} ${styles.btnReject}`}
          disabled={busy !== null}
          onClick={() => {
            const reason = window.prompt("Rejection reason (shown to seller):");
            if (reason) run("reject", () => post(`/listings/${item.id}/reject`, { reason }));
          }}
        >
          Reject
        </button>
        {item.status === "FAILED" && (
          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={busy !== null}
            onClick={() => run("retry", () => post(`/listings/${item.id}/retry`, {}))}
          >
            {busy === "retry" ? "…" : "Retry"}
          </button>
        )}
        <button
          className={`${styles.btn} ${styles.btnDanger}`}
          disabled={busy !== null}
          onClick={() => {
            if (!window.confirm(`Ban seller ${item.seller}? They will be blocked from submitting.`))
              return;
            const reason = window.prompt("Ban reason:") ?? "banned by admin";
            run("ban", () => post(`/sellers/${item.seller}/ban`, { reason }));
          }}
        >
          Ban seller
        </button>
      </div>
      {err && <div className={styles.error}>{err}</div>}
      <div className={styles.muted}>
        Seller {item.seller} · {new Date(item.created_at).toLocaleString()}
      </div>
    </div>
  );
}

export default function QueueSection() {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await adminFetch<{ items: QueueItem[] }>("/queue");
      setItems(data.items);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status}: ${e.message}` : String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>
        Review queue {items ? `(${items.length})` : ""}
        <button
          className={styles.btn}
          style={{ marginLeft: 12 }}
          onClick={load}
        >
          Refresh
        </button>
      </h2>
      {error && <div className={styles.alert}>{error}</div>}
      {items === null && !error && <div className={styles.muted}>Loading…</div>}
      {items !== null && items.length === 0 && (
        <div className={styles.empty}>Queue is clear — nothing needs review. 🎉</div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {(items ?? []).map((item) => (
          <ListingCard key={item.id} item={item} onChanged={load} />
        ))}
      </div>
    </section>
  );
}
