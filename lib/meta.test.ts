/**
 * Meta client tests — mocked fetch. Asserts request shapes (URL, method, body)
 * match the docs re-verified 2026-09-30, plus error mapping.
 */
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

vi.mock("@/lib/db", () => ({
  getAdminSettings: vi.fn(),
}));

import { getAdminSettings } from "@/lib/db";
import { getDecryptedToken, getMetaClient, MetaApiError } from "./meta";
import { encryptToken } from "./ig-token";
import { resetEnvCache } from "./env";

const BASE = "https://graph.instagram.com/v26.0";
const IG_USER_ID = "17841400000000001";

function setEnv() {
  process.env.IG_API_BASE = "https://graph.instagram.com";
  process.env.IG_API_VERSION = "v26.0";
  process.env.IG_APP_ID = "test-app-id";
  process.env.IG_APP_SECRET = "test-app-secret";
  process.env.IG_USER_ID = IG_USER_ID;
  process.env.IG_TOKEN_ENC_KEY = Buffer.alloc(32, 7).toString("hex");
  resetEnvCache();
}

type FetchMock = ReturnType<typeof vi.fn>;
let fetchMock: FetchMock;

function mockJson(payload: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  });
}

function lastCall() {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
  return { url, init, body: init.body ? JSON.parse(init.body as string) : undefined };
}

beforeEach(() => {
  setEnv();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const { enc, iv } = encryptToken("TEST_PLAINTEXT_TOKEN");
  vi.mocked(getAdminSettings).mockResolvedValue({
    token: { enc, iv, expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(), updated_at: new Date().toISOString() },
  } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("getDecryptedToken", () => {
  it("returns the decrypted token", async () => {
    await expect(getDecryptedToken()).resolves.toBe("TEST_PLAINTEXT_TOKEN");
  });

  it("returns null when no token is stored", async () => {
    vi.mocked(getAdminSettings).mockResolvedValue({ token: null } as never);
    await expect(getDecryptedToken()).resolves.toBeNull();
  });
});

describe("sendMessage", () => {
  it("POSTs the documented shape with quick replies", async () => {
    mockJson({ recipient_id: "igsid1", message_id: "mid1" });
    const client = getMetaClient();
    const res = await client.sendMessage("igsid1", {
      text: "hello",
      quickReplies: [{ title: "Post it", payload: "post" }],
    });
    expect(res).toEqual({ messageId: "mid1" });
    const { url, init, body } = lastCall();
    expect(url).toBe(`${BASE}/me/messages`);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer TEST_PLAINTEXT_TOKEN" });
    expect(body).toEqual({
      recipient: { id: "igsid1" },
      messaging_type: "RESPONSE",
      message: {
        text: "hello",
        quick_replies: [{ content_type: "text", title: "Post it", payload: "post" }],
      },
    });
  });

  it("sends image attachments", async () => {
    mockJson({ message_id: "mid2" });
    await getMetaClient().sendMessage("igsid1", { imageUrl: "https://x/y.jpg" });
    const { body } = lastCall();
    expect(body.message.attachment).toEqual({ type: "image", payload: { url: "https://x/y.jpg" } });
  });
});

describe("containers", () => {
  it("child container: image_url + is_carousel_item, no media_type/caption", async () => {
    mockJson({ id: "child1" });
    const id = await getMetaClient().createImageContainer("https://x/1.jpg", { isCarouselItem: true });
    expect(id).toBe("child1");
    const { url, init, body } = lastCall();
    expect(url).toBe(`${BASE}/${IG_USER_ID}/media`);
    expect(init.method).toBe("POST");
    expect(body).toEqual({ image_url: "https://x/1.jpg", is_carousel_item: true });
  });

  it("single-photo container carries the caption", async () => {
    mockJson({ id: "c1" });
    await getMetaClient().createImageContainer("https://x/1.jpg", { caption: "cap" });
    expect(lastCall().body).toEqual({ image_url: "https://x/1.jpg", caption: "cap" });
  });

  it("carousel parent: media_type CAROUSEL + comma children", async () => {
    mockJson({ id: "parent1" });
    const id = await getMetaClient().createCarouselContainer(["a", "b"], "cap");
    expect(id).toBe("parent1");
    expect(lastCall().body).toEqual({ media_type: "CAROUSEL", children: "a,b", caption: "cap" });
  });

  it("getContainerStatus polls status_code", async () => {
    mockJson({ status_code: "FINISHED" });
    const s = await getMetaClient().getContainerStatus("cid1");
    expect(s).toBe("FINISHED");
    const { url, init } = lastCall();
    expect(url).toBe(`${BASE}/cid1?fields=status_code`);
    expect(init.method ?? "GET").toBe("GET");
  });

  it("rejects unknown status_code", async () => {
    mockJson({ status_code: "WEIRD" });
    await expect(getMetaClient().getContainerStatus("cid1")).rejects.toThrow(MetaApiError);
  });
});

describe("publish + permalink + quota", () => {
  it("publishContainer POSTs creation_id", async () => {
    mockJson({ id: "media1" });
    const id = await getMetaClient().publishContainer("parent1");
    expect(id).toBe("media1");
    const { url, body } = lastCall();
    expect(url).toBe(`${BASE}/${IG_USER_ID}/media_publish`);
    expect(body).toEqual({ creation_id: "parent1" });
  });

  it("getPermalink", async () => {
    mockJson({ permalink: "https://www.instagram.com/p/abc/" });
    const p = await getMetaClient().getPermalink("media1");
    expect(p).toBe("https://www.instagram.com/p/abc/");
    expect(lastCall().url).toBe(`${BASE}/media1?fields=permalink`);
  });

  it("getPublishingLimit parses the documented data[0] shape", async () => {
    mockJson({ data: [{ quota_usage: 3, config: { quota_total: 100, quota_duration: 86400 } }] });
    const q = await getMetaClient().getPublishingLimit();
    expect(q).toEqual({ quota_usage: 3, quota_total: 100 });
    expect(lastCall().url).toBe(`${BASE}/${IG_USER_ID}/content_publishing_limit?fields=quota_usage,config`);
  });

  it("getPublishingLimit tolerates the unwrapped shape", async () => {
    mockJson({ quota_usage: 5, config: { quota_total: 50, quota_duration: 86400 } });
    const q = await getMetaClient().getPublishingLimit();
    expect(q).toEqual({ quota_usage: 5, quota_total: 50 });
  });
});

describe("error mapping", () => {
  it("maps code/subcode/status and detects the 24h window error by code", async () => {
    mockJson(
      { error: { message: "Some error", code: 10, error_subcode: 123, fbtrace_id: "x" } },
      400,
    );
    const err = await getMetaClient().sendMessage("igsid1", { text: "hi" }).catch((e) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.code).toBe(10);
    expect(err.subcode).toBe(123);
    expect(err.status).toBe(400);
    expect(err.isWindowError()).toBe(true);
  });

  it("detects the window error by message", async () => {
    mockJson(
      { error: { message: "This message is outside the 24 hours messaging window", code: 190 } },
      400,
    );
    const err = await getMetaClient().sendMessage("igsid1", { text: "hi" }).catch((e) => e);
    expect(err.isWindowError()).toBe(true);
  });

  it("non-window errors are not window errors", async () => {
    mockJson({ error: { message: "Invalid parameter", code: 100 } }, 400);
    const err = await getMetaClient().sendMessage("igsid1", { text: "hi" }).catch((e) => e);
    expect(err.isWindowError()).toBe(false);
  });

  it("throws a clear misconfiguration error when no token is stored", async () => {
    vi.mocked(getAdminSettings).mockResolvedValue({ token: null } as never);
    const err = await getMetaClient().getPublishingLimit().catch((e) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.message).toMatch(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
