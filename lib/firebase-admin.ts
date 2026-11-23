/**
 * Firebase Admin SDK accessors — thin compatibility shim over lib/db.ts.
 *
 * INTEGRATION (coordinator, 2026-09-30): lib/db.ts is the single Admin SDK
 * init point (its getFirebaseApp sets storageBucket, which Storage requires).
 * Everything here delegates to it, so admin routes, crons, and scripts share
 * one initialized app. Prefer importing from "@/lib/db" in new code; this
 * module stays for the existing admin/cron/scripts importers.
 *
 * Memory lesson (2026-09-28): firebase-admin v14 ESM only exports
 * `getDatabase` from `firebase-admin/database` (no modular ref/get). We use
 * Firestore here — `getFirestore` from `firebase-admin/firestore` is a valid
 * named export and works fine.
 */
import { getAuth, type Auth } from "firebase-admin/auth";
import type { Firestore } from "firebase-admin/firestore";
import type { App } from "firebase-admin/app";
import {
  appendListingEvent as dbAppendListingEvent,
  db,
  getAdminSettings as dbGetAdminSettings,
  getFirebaseApp,
  updateAdminSettings as dbUpdateAdminSettings,
} from "./db";
import type { AdminSettings } from "./types";

/** The shared Admin SDK app (initialized once in lib/db.ts). */
export function getAdminApp(): App {
  return getFirebaseApp();
}

/** Firestore instance (default app). */
export function adminDb(): Firestore {
  return db();
}

/** Firebase Auth instance (default app). */
export function adminAuth(): Auth {
  return getAuth(getFirebaseApp());
}

export interface ListingEventInput {
  by?: string | null;
  detail?: string | null;
}

/**
 * Append an audit event to listings/{id}/events (append-only).
 * `type` is a short machine tag, e.g. "approved" | "rejected" | "caption_edited"
 * | "retry" | "published" | "publish_failed".
 */
export async function appendListingEvent(
  listingId: string,
  type: string,
  input: ListingEventInput = {},
): Promise<void> {
  const event: { type: string; at?: string; [k: string]: unknown } = { type };
  if (input.by != null) event.by = input.by;
  if (input.detail != null) event.detail = input.detail;
  await dbAppendListingEvent(listingId, event);
}

/** Read admin_settings/global merged over env-backed defaults. */
export async function getAdminSettings(): Promise<AdminSettings> {
  return dbGetAdminSettings();
}

/** Merge-update admin_settings/global (creates the doc on first use). */
export async function updateAdminSettings(patch: Record<string, unknown>): Promise<void> {
  await dbUpdateAdminSettings(patch);
}
