/**
 * Phase 1 — log unit tests: PII redaction at the log boundary.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { log, redactPII } from "./log";

describe("redactPII", () => {
  it("redacts phone numbers", () => {
    expect(redactPII("call me on 0301 2345678 tomorrow")).toContain("[phone]");
    expect(redactPII("call me on 0301 2345678 tomorrow")).not.toContain("0301");
  });

  it("redacts email addresses", () => {
    expect(redactPII("mail me at seller@example.com")).toBe("mail me at [email]");
  });

  it("truncates long IG-scoped numeric ids but keeps a prefix", () => {
    const out = redactPII("from 98765432109876543");
    expect(out).toContain("987654…");
    expect(out).not.toContain("98765432109876543");
  });

  it("leaves ordinary text alone", () => {
    expect(redactPII("Assalam o alaikum, dress sell karni hai")).toBe("Assalam o alaikum, dress sell karni hai");
  });
});

describe("log secret redaction", () => {
  afterEach(() => vi.restoreAllMocks());

  function capture(level: "info" | "warn" | "error", fn: () => void): string {
    const lines: string[] = [];
    const target = level === "info" ? console.log : level === "warn" ? console.warn : console.error;
    vi.spyOn(console, level === "info" ? "log" : level).mockImplementation((...args: unknown[]) => {
      void target;
      lines.push(args.map(String).join(" "));
    });
    fn();
    return lines.join("\n");
  }

  it("redacts secret-valued keys", () => {
    const out = capture("info", () => log.info("test", { api_key: "sk-live-123", app_secret: "shhh" }));
    expect(out).toContain("[redacted]");
    expect(out).not.toContain("sk-live-123");
    expect(out).not.toContain("shhh");
  });

  it("redacts nested secrets and PII in fields", () => {
    const out = capture("warn", () =>
      log.warn("test", { nested: { token: "abc", note: "mail seller@example.com" } }),
    );
    expect(out).not.toContain("seller@example.com");
    expect(out).toContain("[email]");
    expect(out).not.toContain('"token":"abc"');
  });

  it("emits valid JSON lines", () => {
    const out = capture("error", () => log.error("boom", { mid: "m_123" }));
    expect(() => JSON.parse(out)).not.toThrow();
    expect(JSON.parse(out).level).toBe("error");
  });
});
