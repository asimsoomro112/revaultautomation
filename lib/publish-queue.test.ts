/**
 * enqueuePublishWorker tests — the admin dedup id must be unique per admin
 * action (2026-11-24 re-audit pass 2, Lane B NEW-2). A static
 * `admin-publish:{id}` is silently dropped by QStash when a genuine second
 * action for the same listing lands inside the dedup window — e.g. approve
 * → QStash 502 → rollback → approve again: the second enqueue is suppressed
 * while the API reports success, stranding the listing in QUEUED/APPROVED
 * with no worker. The status guards (approve rejects APPROVED, retry
 * requires FAILED) already block true double-click duplicates, so the id
 * must vary per action, not per listing.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./qstash", () => ({
  enqueueWorker: vi.fn(async () => {}),
}));
vi.mock("./log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { enqueueWorker } from "./qstash";
import { enqueuePublishWorker } from "./publish-queue";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("enqueuePublishWorker", () => {
  it("gives two separate admin actions distinct deduplication ids", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValueOnce(2000);
    try {
      expect(await enqueuePublishWorker("lst1")).toBe(true);
      expect(await enqueuePublishWorker("lst1")).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
    expect(vi.mocked(enqueueWorker)).toHaveBeenCalledTimes(2);
    const first = vi.mocked(enqueueWorker).mock.calls[0]![2]?.deduplicationId;
    const second = vi.mocked(enqueueWorker).mock.calls[1]![2]?.deduplicationId;
    expect(first).toBe("admin-publish:lst1:1000");
    expect(second).toBe("admin-publish:lst1:2000");
    expect(first).not.toBe(second);
  });

  it("enqueues the publish route with the listing payload", async () => {
    await enqueuePublishWorker("lst1");
    expect(vi.mocked(enqueueWorker)).toHaveBeenCalledWith(
      "publish",
      { kind: "publish", listing_id: "lst1" },
      expect.objectContaining({ deduplicationId: expect.stringContaining("admin-publish:lst1:") }),
    );
  });

  it("returns false (no throw) when the enqueue fails", async () => {
    vi.mocked(enqueueWorker).mockRejectedValueOnce(new Error("QStash down"));
    expect(await enqueuePublishWorker("lst1")).toBe(false);
  });
});
