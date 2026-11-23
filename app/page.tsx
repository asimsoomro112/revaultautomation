"use client";

/**
 * Root landing page – shows bot status and links to the admin dashboard.
 * No secrets are exposed. Works without any env vars configured.
 */
import { useEffect, useState } from "react";
import LogoMark from "./components/LogoMark";
import styles from "./home.module.css";

type HealthData = {
  ok: boolean;
  checks?: {
    firestore?: string;
    qstash?: string;
    gemini?: string;
    ig_token?: string;
  };
  ig_token_expires_in_days?: number | null;
} | null;

export default function HomePage() {
  const [health, setHealth] = useState<HealthData>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setHealth(d))
      .catch(() => setHealth(null))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.logoRow}>
          <LogoMark size={36} className={styles.logoMark} />
          <h1 className={styles.title}>
            ReVault <span className={styles.titleAccent}>DM Bot</span>
          </h1>
        </div>

        <p className={styles.subtitle}>
          Instagram DM → moderated, captioned, scheduled carousel post.
          Fully automated for{" "}
          <a
            href="https://www.instagram.com/therevaultofficial"
            target="_blank"
            rel="noopener noreferrer"
            className={styles.link}
          >
            @therevaultofficial
          </a>
        </p>

        <div className={styles.statusSection}>
          <h2 className={styles.sectionTitle}>System status</h2>
          {loading ? (
            <div className={styles.statusRow}>
              <span>Checking</span>
              <span className={`${styles.statusValue} ${styles.statusUnknown}`}>…</span>
            </div>
          ) : health ? (
            <div className={styles.statusGrid}>
              <StatusRow label="API" ok={health.ok} />
              <StatusRow label="Firestore" ok={health.checks?.firestore === "ok"} />
              <StatusRow label="QStash" ok={health.checks?.qstash === "ok"} />
              <StatusRow label="Gemini" ok={health.checks?.gemini === "configured"} />
              {health.ig_token_expires_in_days != null && (
                <div className={styles.statusRow}>
                  <span>IG token</span>
                  <span
                    className={`${styles.statusValue} ${
                      health.ig_token_expires_in_days > 7
                        ? styles.statusOk
                        : health.ig_token_expires_in_days > 2
                          ? styles.statusUnknown
                          : styles.statusBad
                    }`}
                  >
                    {health.ig_token_expires_in_days}d remaining
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div className={styles.statusRow}>
              <span>Health endpoint</span>
              <span className={`${styles.statusValue} ${styles.statusBad}`}>Unreachable</span>
            </div>
          )}
        </div>

        <div className={styles.actions}>
          <a href="/admin" className={styles.primaryBtn}>
            Open admin dashboard
          </a>
        </div>

        <div className={styles.footer}>
          <span className={styles.footerText}>
            Next.js 16, Gemini, Firestore, QStash, Cloudinary
          </span>
        </div>
      </div>
    </div>
  );
}

function StatusRow({ label, ok }: { label: string; ok?: boolean | undefined }) {
  const text = ok === true ? "Connected" : ok === false ? "Down" : "Unknown";
  const valueClass =
    ok === true
      ? styles.statusOk
      : ok === false
        ? styles.statusBad
        : styles.statusUnknown;
  return (
    <div className={styles.statusRow}>
      <span>{label}</span>
      <span className={`${styles.statusValue} ${valueClass}`}>{text}</span>
    </div>
  );
}
