"use client";

/**
 * Root landing page – shows bot status and links to the admin dashboard.
 * No secrets are exposed. Works without any env vars configured.
 */
import { useEffect, useState } from "react";

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
    <div style={styles.page}>
      <div style={styles.glow} />
      <div style={styles.card}>
        <div style={styles.logoRow}>
          <div style={styles.logoIcon}>
            <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
              <rect width="36" height="36" rx="10" fill="url(#g1)" />
              <path
                d="M10 18l4-6 4 6 4-6 4 6"
                stroke="#fff"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <defs>
                <linearGradient id="g1" x1="0" y1="0" x2="36" y2="36">
                  <stop stopColor="#6366f1" />
                  <stop offset="1" stopColor="#a855f7" />
                </linearGradient>
              </defs>
            </svg>
          </div>
          <h1 style={styles.title}>
            ReVault <span style={styles.titleAccent}>DM Bot</span>
          </h1>
        </div>

        <p style={styles.subtitle}>
          Instagram DM → moderated, captioned, scheduled carousel post.
          <br />
          Fully automated for{" "}
          <a
            href="https://www.instagram.com/therevaultofficial"
            target="_blank"
            rel="noopener noreferrer"
            style={styles.link}
          >
            @therevaultofficial
          </a>
        </p>

        <div style={styles.statusSection}>
          <h2 style={styles.sectionTitle}>System Status</h2>
          {loading ? (
            <div style={styles.statusRow}>
              <span style={dotStyle("#6366f1")} />
              <span style={styles.statusLabel}>Checking…</span>
            </div>
          ) : health ? (
            <div style={styles.statusGrid}>
              <StatusRow label="API" ok={health.ok} />
              <StatusRow label="Firestore" ok={health.checks?.firestore === "ok"} />
              <StatusRow label="QStash" ok={health.checks?.qstash === "ok"} />
              <StatusRow label="Gemini" ok={health.checks?.gemini === "configured"} />
              {health.ig_token_expires_in_days != null && (
                <div style={styles.statusRow}>
                  <span
                    style={dotStyle(
                      health.ig_token_expires_in_days > 7
                        ? "#22c55e"
                        : health.ig_token_expires_in_days > 2
                          ? "#eab308"
                          : "#ef4444"
                    )}
                  />
                  <span style={styles.statusLabel}>
                    IG Token — {health.ig_token_expires_in_days}d remaining
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div style={styles.statusRow}>
              <span style={dotStyle("#ef4444")} />
              <span style={styles.statusLabel}>
                Health endpoint unreachable (env may not be configured)
              </span>
            </div>
          )}
        </div>

        <div style={styles.actions}>
          <a href="/admin" style={styles.primaryBtn}>
            Open Admin Dashboard →
          </a>
        </div>

        <div style={styles.footer}>
          <span style={styles.footerText}>
            Next.js 16 · Gemini · Firestore · QStash · Cloudinary
          </span>
        </div>
      </div>
    </div>
  );
}

function StatusRow({ label, ok }: { label: string; ok?: boolean | undefined }) {
  const color =
    ok === true ? "#22c55e" : ok === false ? "#ef4444" : "#6b7280";
  const text = ok === true ? "Connected" : ok === false ? "Down" : "Unknown";
  return (
    <div style={styles.statusRow}>
      <span style={dotStyle(color)} />
      <span style={styles.statusLabel}>
        {label} — <span style={{ color }}>{text}</span>
      </span>
    </div>
  );
}

/* ---------- inline styles (no extra CSS file needed) ---------- */

function dotStyle(color: string): React.CSSProperties {
  return {
    width: 8,
    height: 8,
    borderRadius: "50%",
    backgroundColor: color,
    boxShadow: `0 0 8px ${color}60`,
    flexShrink: 0,
  };
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "linear-gradient(145deg, #0b0e13 0%, #13111c 50%, #0b0e13 100%)",
    fontFamily:
      "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    color: "#e2e8f0",
    padding: 24,
    position: "relative",
    overflow: "hidden",
  },
  glow: {
    position: "absolute",
    top: "20%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    width: 600,
    height: 600,
    background:
      "radial-gradient(circle, rgba(99,102,241,0.12) 0%, transparent 70%)",
    pointerEvents: "none" as const,
    zIndex: 0,
  },
  card: {
    position: "relative",
    zIndex: 1,
    maxWidth: 520,
    width: "100%",
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 20,
    padding: "40px 36px 32px",
    backdropFilter: "blur(24px)",
    boxShadow: "0 8px 40px rgba(0,0,0,0.4)",
  },
  logoRow: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    marginBottom: 20,
  },
  logoIcon: {},
  title: {
    fontSize: 28,
    fontWeight: 700,
    margin: 0,
    letterSpacing: "-0.02em",
    color: "#f1f5f9",
  },
  titleAccent: {
    background: "linear-gradient(135deg, #6366f1, #a855f7)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 1.6,
    color: "#94a3b8",
    margin: "0 0 28px 0",
  },
  link: {
    color: "#818cf8",
    textDecoration: "none",
  },
  statusSection: {
    background: "rgba(0,0,0,0.25)",
    borderRadius: 14,
    padding: "20px 22px",
    marginBottom: 28,
    border: "1px solid rgba(255,255,255,0.05)",
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.08em",
    color: "#64748b",
    margin: "0 0 14px 0",
  },
  statusGrid: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 10,
  },
  statusRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },

  statusLabel: {
    fontSize: 13,
    color: "#cbd5e1",
  },
  actions: {
    display: "flex",
    gap: 12,
  },
  primaryBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    padding: "12px 24px",
    fontSize: 14,
    fontWeight: 600,
    color: "#fff",
    background: "linear-gradient(135deg, #6366f1, #7c3aed)",
    border: "none",
    borderRadius: 12,
    textDecoration: "none",
    cursor: "pointer",
    transition: "opacity 0.2s",
    boxShadow: "0 4px 20px rgba(99,102,241,0.3)",
  },
  footer: {
    marginTop: 24,
    textAlign: "center" as const,
  },
  footerText: {
    fontSize: 11,
    color: "#475569",
    letterSpacing: "0.04em",
  },
};
