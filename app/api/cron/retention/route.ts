/**
 * Vercel Cron: media retention cleanup — GET /api/cron/retention
 * Schedule (vercel.json): `30 3 * * *` UTC = 08:30 PKT daily.
 *
 * Deletes `revault/listings/raw/{listingId}/…` originals (Cloudinary) for
 * listings in terminal states (PUBLISHED / REJECTED) created more than
 * RETENTION_DAYS ago. Processed `slides/` are the published artifact and are
 * KEPT (cheap; needed for reposts/appeals).
 *
 * Cutoff uses created_at (ISO strings sort lexicographically). Two
 * single-field queries — no composite index required.
 *
 * GET only. Idempotent (deleting already-gone assets is a no-op).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/cron-auth";
import { adminDb } from "@/lib/firebase-admin";
import { getEnv } from "@/lib/env";
import { deletePrefix } from "@/lib/storage";
import { log } from "@/lib/log";
import type { ListingStatus } from "@/lib/types";

const TERMINAL: ListingStatus[] = ["PUBLISHED", "REJECTED"];

export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const retentionDays = getEnv().RETENTION_DAYS;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000).toISOString();

  let listingsScanned = 0;
  let prefixesDeleted = 0;
  const errors: string[] = [];

  for (const status of TERMINAL) {
    const snap = await adminDb()
      .collection("listings")
      .where("status", "==", status)
      .where("created_at", "<", cutoff)
      .get();
    for (const doc of snap.docs) {
      listingsScanned += 1;
      const prefix = `raw/${doc.id}/`;
      try {
        // Bulk delete by prefix — never touch slides/ (only raw originals).
        await deletePrefix(prefix);
        prefixesDeleted += 1;
        log.info("cron/retention: deleted raw originals", { listing: doc.id });
      } catch (err) {
        errors.push(`${prefix}: ${String(err).slice(0, 80)}`);
      }
    }
  }

  const result = {
    ok: true,
    retention_days: retentionDays,
    cutoff,
    listings_scanned: listingsScanned,
    prefixes_deleted: prefixesDeleted,
    errors: errors.slice(0, 10),
  };
  log.info("cron/retention: done", result);
  return NextResponse.json(result);
}
