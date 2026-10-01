/**
 * Telegram admin alerts — Phase 5 implementation.
 *
 * Sends a message to the admin chat via the Bot API:
 *   POST https://api.telegram.org/bot<TOKEN>/sendMessage
 *   { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true }
 *
 * Docs re-verified 2026-09-30: sendMessage text limit is 4096 chars;
 * HTML mode supports <b> <i> <u> <s> <code> <pre> <a href> <blockquote>;
 * literal < > & must be escaped as &lt; &gt; &amp;.
 *
 * Contract: notifyAdmin NEVER throws — alert failures are logged, never fatal
 * to the calling worker. Callers pass preformatted PLAIN text; we escape the
 * whole body (callers should not embed raw HTML tags).
 * Safe no-op (warn log) when TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_CHAT_ID
 * are unset.
 */
import { getEnv, resetEnvCache } from "./env";
import { log } from "./log";

export interface AlertOpts {
  listingId?: string;
  igsid?: string;
}

/** Telegram sendMessage text limit. */
export const TELEGRAM_MAX_TEXT = 4096;

/** Escape the three HTML-significant chars Telegram requires. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Truncate to the Telegram text limit, marking the cut. */
export function truncateForTelegram(text: string): string {
  if (text.length <= TELEGRAM_MAX_TEXT) return text;
  return text.slice(0, TELEGRAM_MAX_TEXT - 1) + "…";
}

export async function notifyAdmin(text: string, _opts?: AlertOpts): Promise<void> {
  const env = getEnv();
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_ADMIN_CHAT_ID;
  if (!token || !chatId) {
    log.warn("notifyAdmin: Telegram not configured — alert dropped (no-op)", {
      preview: text.slice(0, 120),
    });
    return;
  }
  const body = {
    chat_id: chatId,
    text: truncateForTelegram(escapeHtml(text)),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
    if (!res.ok || data.ok === false) {
      log.error("notifyAdmin: Telegram API rejected the message", {
        status: res.status,
        description: (data.description ?? "").slice(0, 200),
      });
    }
  } catch (err) {
    log.error("notifyAdmin: send failed (network)", { err: String(err).slice(0, 200) });
  }
}

// Re-exported for tests that mutate process.env between cases.
export { resetEnvCache };
