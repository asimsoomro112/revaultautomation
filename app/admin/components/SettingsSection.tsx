"use client";

import { useCallback, useEffect, useState } from "react";
import { adminFetch, ApiError, post, type SettingsInfo } from "./api";
import styles from "../styles.module.css";

type Form = Omit<SettingsInfo, "kill_switch">;

/**
 * Settings panel — edits the operational knobs the GET endpoint already
 * returns. Only changed fields are sent (POST /settings is a partial
 * update). Kill switch is read-only here; it lives in its own section.
 */
export default function SettingsSection() {
  const [loaded, setLoaded] = useState<SettingsInfo | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await adminFetch<SettingsInfo>("/settings");
      setLoaded(data);
      const { kill_switch: _kill, ...rest } = data;
      setForm(rest);
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

  async function save() {
    if (!form || !loaded) return;
    // Diff against the loaded values — send only what changed.
    const patch: Record<string, unknown> = {};
    (Object.keys(form) as Array<keyof Form>).forEach((k) => {
      if (JSON.stringify(form[k]) !== JSON.stringify(loaded[k])) patch[k] = form[k];
    });
    if (Object.keys(patch).length === 0) {
      setNotice("No changes to save.");
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const data = await post<{ ok: boolean; settings: SettingsInfo }>("/settings", patch);
      setLoaded(data.settings);
      const { kill_switch: _kill, ...rest } = data.settings;
      setForm(rest);
      setNotice("Settings saved.");
    } catch (e) {
      setError(e instanceof ApiError ? `${e.status}: ${e.message}` : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={styles.section} id="settings">
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Settings</h2>
        <button className={styles.btn} onClick={load} disabled={saving}>
          Refresh
        </button>
      </div>
      {error && <div className={styles.alert}>{error}</div>}
      {notice && <div className={styles.notice}>{notice}</div>}
      {form === null && !error && <div className={styles.muted}>Loading…</div>}
      {form !== null && (
        <>
          <div className={styles.formGrid}>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="set-mode">
                Publish mode
              </label>
              <select
                id="set-mode"
                className={styles.input}
                value={form.publish_mode}
                onChange={(e) =>
                  setForm({ ...form, publish_mode: e.target.value })
                }
              >
                <option value="review">Review — manual approve</option>
                <option value="auto">Auto — publish on approve</option>
                <option value="dry_run">Dry run — no posting</option>
              </select>
              <span className={styles.fieldHint}>
                Review is the safe default; auto skips the queue.
              </span>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="set-max">
                Max posts per day
              </label>
              <input
                id="set-max"
                className={styles.input}
                type="number"
                min={1}
                max={50}
                value={form.max_posts_per_day}
                onChange={(e) =>
                  setForm({ ...form, max_posts_per_day: Number(e.target.value) })
                }
              />
              <span className={styles.fieldHint}>1–50. Daily quota resets at midnight PKT.</span>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="set-gap">
                Min gap between posts (minutes)
              </label>
              <input
                id="set-gap"
                className={styles.input}
                type="number"
                min={0}
                max={1440}
                value={form.min_gap_minutes}
                onChange={(e) =>
                  setForm({ ...form, min_gap_minutes: Number(e.target.value) })
                }
              />
              <span className={styles.fieldHint}>0–1440. Spreads posts through the day.</span>
            </div>

            <div className={styles.field}>
              <span className={styles.fieldLabel} id="set-window-label">
                Posting window (PKT)
              </span>
              <div className={styles.timeRow} role="group" aria-labelledby="set-window-label">
                <input
                  className={styles.input}
                  type="time"
                  aria-label="Window start"
                  value={form.posting_window.start}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      posting_window: { ...form.posting_window, start: e.target.value },
                    })
                  }
                />
                <span className={styles.muted} aria-hidden="true">
                  to
                </span>
                <input
                  className={styles.input}
                  type="time"
                  aria-label="Window end"
                  value={form.posting_window.end}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      posting_window: { ...form.posting_window, end: e.target.value },
                    })
                  }
                />
              </div>
              <span className={styles.fieldHint}>
                Posts only slot inside this window ({form.posting_window.tz}).
              </span>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="set-retention">
                Retention (days)
              </label>
              <input
                id="set-retention"
                className={styles.input}
                type="number"
                min={1}
                max={365}
                value={form.retention_days}
                onChange={(e) =>
                  setForm({ ...form, retention_days: Number(e.target.value) })
                }
              />
              <span className={styles.fieldHint}>
                1–365. Originals older than this are deleted by the nightly job.
              </span>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="set-seller-limit">
                Max listings per seller per day
              </label>
              <input
                id="set-seller-limit"
                className={styles.input}
                type="number"
                min={1}
                max={50}
                value={form.max_listings_per_seller_per_day}
                onChange={(e) =>
                  setForm({ ...form, max_listings_per_seller_per_day: Number(e.target.value) })
                }
              />
              <span className={styles.fieldHint}>1–50. Flood guard per seller.</span>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor="set-debounce">
                Photo debounce (seconds)
              </label>
              <input
                id="set-debounce"
                className={styles.input}
                type="number"
                min={5}
                max={300}
                value={form.photo_debounce_seconds}
                onChange={(e) =>
                  setForm({ ...form, photo_debounce_seconds: Number(e.target.value) })
                }
              />
              <span className={styles.fieldHint}>
                5–300. How long the bot waits for the last photo before extracting.
              </span>
            </div>

            <div className={styles.field}>
              <span className={styles.fieldLabel}>Kill switch</span>
              <span className={styles.muted}>
                {loaded?.kill_switch ? "ON — publishing is parked" : "Off"}
                . Change it in the Kill switch section above.
              </span>
            </div>
          </div>

          <div className={styles.formActions}>
            <button
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={saving}
              onClick={save}
            >
              {saving ? "Saving…" : "Save settings"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
