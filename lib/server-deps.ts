/**
 * Real dependency wiring for the Phase 2 worker routes.
 *
 * Builds the `Deps` port from the landed phase modules:
 *   db      → lib/db.ts        (Phase 1, Firestore)
 *   gemini  → lib/gemini.ts    (Phase 2, @google/genai)
 *   meta    → lib/meta.ts      (Phase 4, Instagram API)
 *   notify  → lib/telegram.ts  (Phase 5, no-op until configured)
 *   enqueue → lib/qstash.ts    (Phase 1)
 *   caption → lib/caption.ts   (Phase 3)
 *   storage → lib/storage.ts   (Cloudinary private assets; photo bytes)
 *
 * Called inside route handlers (request time), never at import time, so
 * `next build` and unit tests stay credential-free. getMetaClient() /
 * getGeminiClient() throw clear errors when their env is missing.
 */
import {
  appendListingEvent,
  blankListingDoc,
  createListing,
  getAdminSettings,
  getListing,
  getOrCreateConversation,
  newListingId,
  recordPhash,
  saveConversation,
  saveListing,
} from "./db";
import { downloadBytes } from "./storage";
import { getGeminiClient } from "./gemini";
import { getMetaClient } from "./meta";
import { notifyAdmin } from "./telegram";
import { enqueueWorker } from "./qstash";
import { buildCaption } from "./caption";
import { getEnv } from "./env";
import type { Deps } from "./conversation";
import type { FinalizeDeps } from "./finalize";

export function buildDeps(): Deps {
  return {
    db: {
      getOrCreateConversation,
      saveConversation,
      getListing,
      saveListing,
      createListing,
      appendListingEvent,
      getAdminSettings,
      newListingId,
      recordPhash,
      blankListingDoc,
    },
    gemini: getGeminiClient(),
    meta: getMetaClient(),
    notifyAdmin,
    enqueueWorker: (route, payload, opts) => enqueueWorker(route, payload, opts ?? {}),
    buildCaption,
    now: () => new Date().toISOString(),
    maxListingsPerSellerPerDay: getEnv().MAX_LISTINGS_PER_SELLER_PER_DAY,
  };
}

export function buildFinalizeDeps(): FinalizeDeps {
  const base: Deps = buildDeps();
  const finalizeDeps: FinalizeDeps = { ...base, downloadBytes };
  return finalizeDeps;
}
