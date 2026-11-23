/**
 * Phase 1 — webhook unit tests: signature verification, GET challenge
 * handshake, and payload parsing across all fixture kinds.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { nonEcho, parseWebhookPayload, verifyGetChallenge, verifySignature } from "./webhook";
import type { NormalizedInbound } from "./types";

const SECRET = "test_app_secret_0123456789";

function sign(body: Buffer, secret: string = SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

function fixture(name: string): unknown {
  const p = path.join(__dirname, "..", "test", "fixtures", "webhooks", `${name}.json`);
  return JSON.parse(readFileSync(p, "utf8"));
}

describe("verifySignature", () => {
  const body = Buffer.from('{"object":"instagram","entry":[]}');

  it("accepts a valid signature", () => {
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const tampered = Buffer.from('{"object":"instagram","entry":[{"x":1}]}');
    expect(verifySignature(tampered, sign(body), SECRET)).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(verifySignature(body, sign(body, "wrong_secret"), SECRET)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifySignature(body, null, SECRET)).toBe(false);
  });

  it("rejects a malformed header (no sha256= prefix)", () => {
    expect(verifySignature(body, createHmac("sha256", SECRET).update(body).digest("hex"), SECRET)).toBe(false);
  });

  it("rejects a non-hex / wrong-length digest", () => {
    expect(verifySignature(body, "sha256=zzzz", SECRET)).toBe(false);
    expect(verifySignature(body, "sha256=" + "ab".repeat(16), SECRET)).toBe(false); // 32 hex chars
  });

  it("rejects when the app secret is empty", () => {
    expect(verifySignature(body, sign(body), "")).toBe(false);
  });

  it("is case-insensitive on the hex digest", () => {
    const upper = "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex").toUpperCase();
    expect(verifySignature(body, upper, SECRET)).toBe(true);
  });
});

describe("verifyGetChallenge", () => {
  const TOKEN = "test_verify_token";
  const ok = () =>
    new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": TOKEN, "hub.challenge": "CHALLENGE_123" });

  it("returns the challenge when mode and token match", () => {
    expect(verifyGetChallenge(ok(), TOKEN)).toBe("CHALLENGE_123");
  });

  it("returns null on token mismatch", () => {
    const p = ok();
    p.set("hub.verify_token", "wrong");
    expect(verifyGetChallenge(p, TOKEN)).toBeNull();
  });

  it("returns null when mode is not subscribe", () => {
    const p = ok();
    p.set("hub.mode", "unsubscribe");
    expect(verifyGetChallenge(p, TOKEN)).toBeNull();
  });

  it("returns null when the challenge is missing", () => {
    const p = ok();
    p.delete("hub.challenge");
    expect(verifyGetChallenge(p, TOKEN)).toBeNull();
  });
});

describe("parseWebhookPayload", () => {
  it("parses a text message", () => {
    const [m] = parseWebhookPayload(fixture("text")) as [NormalizedInbound];
    expect(m.kind).toBe("text");
    expect(m.mid).toBe("m_AYJxYzAbC123dEfGhIjK1");
    expect(m.sender_igsid).toBe("98765432109876543");
    expect(m.recipient_igid).toBe("17841400008460056");
    expect(m.text).toContain("Assalam o alaikum");
    expect(m.image_url).toBeNull();
  });

  it("parses a single image attachment", () => {
    const [m] = parseWebhookPayload(fixture("single-image")) as [NormalizedInbound];
    expect(m.kind).toBe("image");
    expect(m.image_url).toContain("scontent.cdninstagram.com");
  });

  it("parses a multi-entry image burst into two inbounds", () => {
    const ms = parseWebhookPayload(fixture("multi-image"));
    expect(ms).toHaveLength(2);
    expect(ms.map((m) => m.kind)).toEqual(["image", "image"]);
    expect(ms[0]?.mid).not.toBe(ms[1]?.mid);
  });

  it("maps a sticker to unsupported with hint 'sticker'", () => {
    const [m] = parseWebhookPayload(fixture("sticker")) as [NormalizedInbound];
    expect(m.kind).toBe("unsupported");
    expect(m.unsupported_hint).toBe("sticker");
  });

  it("keeps echoes in the output (the route skips them)", () => {
    const [m] = parseWebhookPayload(fixture("echo")) as [NormalizedInbound];
    expect(m.kind).toBe("echo");
    expect(nonEcho([m])).toHaveLength(0);
  });

  it("maps video to unsupported with hint 'video'", () => {
    const [m] = parseWebhookPayload(fixture("video")) as [NormalizedInbound];
    expect(m.kind).toBe("unsupported");
    expect(m.unsupported_hint).toBe("video");
  });

  it("parses a quick reply with its payload", () => {
    const [m] = parseWebhookPayload(fixture("quick-reply")) as [NormalizedInbound];
    expect(m.kind).toBe("quick_reply");
    expect(m.quick_reply_payload).toBe("CONFIRM_POST");
    expect(m.text).toBe("Post it");
  });

  it("maps an empty message to unknown", () => {
    const ms = parseWebhookPayload({
      object: "instagram",
      entry: [
        {
          id: "17841400008460056",
          messaging: [
            {
              sender: { id: "98765432109876543" },
              recipient: { id: "17841400008460056" },
              timestamp: 1790812854123,
              message: { mid: "m_unknown1" },
            },
          ],
        },
      ],
    });
    expect(ms).toHaveLength(1);
    expect(ms[0]?.kind).toBe("unknown");
  });

  it("returns [] for a non-instagram object", () => {
    expect(parseWebhookPayload({ object: "page", entry: [] })).toEqual([]);
  });

  it("returns [] for garbage input", () => {
    expect(parseWebhookPayload(null)).toEqual([]);
    expect(parseWebhookPayload("nope")).toEqual([]);
    expect(parseWebhookPayload({})).toEqual([]);
  });

  it("skips malformed entries without killing the batch", () => {
    const ms = parseWebhookPayload({
      object: "instagram",
      entry: [
        { broken: true },
        {
          id: "17841400008460056",
          messaging: [
            {
              sender: { id: "98765432109876543" },
              recipient: { id: "17841400008460056" },
              timestamp: 1790812854123,
              message: { mid: "m_ok1", text: "hello" },
            },
            { totally: "broken" },
          ],
        },
      ],
    });
    expect(ms).toHaveLength(1);
    expect(ms[0]?.kind).toBe("text");
  });

  it("ignores messaging items without a message (read receipts etc.)", () => {
    const ms = parseWebhookPayload({
      object: "instagram",
      entry: [
        {
          id: "17841400008460056",
          messaging: [{ sender: { id: "1" }, recipient: { id: "2" }, timestamp: 1, read: { mid: "x" } }],
        },
      ],
    });
    expect(ms).toEqual([]);
  });
});
