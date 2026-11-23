/**
 * Publish-worker enqueue helper for admin actions (approve / retry).
 *
 * Thin best-effort wrapper around Phase 1's `enqueueWorker` (lib/qstash.ts) —
 * single enqueue path, no duplication. The worker contract:
 *   POST {APP_BASE_URL}/api/workers/publish  body { kind: "publish", listing_id }
 * (see lib/types.ts PublishPayload).
 *
 * Returns false (and logs) instead of throwing when QStash is unconfigured,
 * so the admin UI can surface "worker not enqueued".
 */
import { log } from "./log";
import { enqueueWorker } from "./qstash";

export async function enqueuePublishWorker(listingId: string): Promise<boolean> {
  try {
    await enqueueWorker(
      "publish",
      { kind: "publish", listing_id: listingId },
      { deduplicationId: `admin-publish:${listingId}` },
    );
    return true;
  } catch (err) {
    log.warn("publish-queue: QStash enqueue failed — publish worker NOT enqueued", {
      listingId,
      err: String(err).slice(0, 160),
    });
    return false;
  }
}
