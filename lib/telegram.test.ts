import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import {
  notifyAdmin,
  escapeHtml,
  truncateForTelegram,
  resetEnvCache,
  TELEGRAM_MAX_TEXT,
} from "./telegram";

describe("notifyAdmin", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "TOKEN123";
    process.env.TELEGRAM_ADMIN_CHAT_ID = "999";
    resetEnvCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_ADMIN_CHAT_ID;
    resetEnvCache();
  });

  it("POSTs to the bot sendMessage URL with the right shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 1 } }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await notifyAdmin("hello");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/botTOKEN123/sendMessage");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      chat_id: "999",
      text: "hello",
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  });

  it("escapes HTML-significant chars", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await notifyAdmin('<b>bold</b> & "quoted"');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { text: string };
    expect(body.text).toBe("&lt;b&gt;bold&lt;/b&gt; &amp; \"quoted\"");
  });

  it("truncates text to the 4096-char limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await notifyAdmin("x".repeat(5000));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { text: string };
    expect(body.text.length).toBe(TELEGRAM_MAX_TEXT);
    expect(body.text.endsWith("…")).toBe(true);
  });

  it("is a safe no-op (no fetch, no throw) when unconfigured", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_ADMIN_CHAT_ID;
    resetEnvCache();
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(notifyAdmin("hello")).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not throw when Telegram rejects the message", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: "Bad Request: chat not found" }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(notifyAdmin("hello")).resolves.toBeUndefined();
  });

  it("does not throw on network failure", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("socket hang up"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(notifyAdmin("hello")).resolves.toBeUndefined();
  });
});

describe("escapeHtml / truncateForTelegram", () => {
  it("escapes & < >", () => {
    expect(escapeHtml("a&b<c>d")).toBe("a&amp;b&lt;c&gt;d");
  });
  it("leaves short text untouched", () => {
    expect(truncateForTelegram("ok")).toBe("ok");
  });
});
