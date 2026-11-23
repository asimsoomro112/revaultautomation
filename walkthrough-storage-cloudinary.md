# Storage Swap Walkthrough — Firebase Storage → Cloudinary (photos only)

**Date:** 2026-10-01 · **Owner:** storage-swap subagent (spawned by the Phase 6
coordinator) · **Status:** ✅ done — refactor complete, tests green, tsc clean,
committed.

## Why

Asim: "firebase hata ke cloudinary lagao, firebase paid hai storage" —
replace Firebase Storage with Cloudinary for **photo storage only**.
Firestore (database) and Firebase Auth (admin Google login) **stay** — their
free tiers cost nothing, so there was no reason to move them. Cloudinary free
tier: 25 pooled credits/month (1 credit = 1GB storage *or* 1GB bandwidth *or*
1000 transformations), no credit card.

Free-tier math for this bot: even 1000 listings × 9 photos × ~200KB ≈
**1.8GB ≈ ~2 of 25 credits**. Comfortable headroom.

## What changed

| File | Change |
|---|---|
| `lib/storage.ts` | **Rewritten** as the single Cloudinary module: `toPublicId`, `downloadImageToStorage`, `uploadBytes`, `downloadBytes`, `signedReadUrl`, `deletePath`, `deletePrefix`, `requireCloudinaryEnv` via `lib/env.ts`, `resetCloudinaryConfigForTests` |
| `lib/env.ts` | `FIREBASE_STORAGE_BUCKET` removed; added `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` + `requireCloudinaryEnv()` |
| `lib/db.ts` | Storage half removed: `getStorage` import, `storageBucket` init option, `storage()`, `downloadBytes`, `uploadBytes`, `signedReadUrl`. **Firestore-only now.** |
| `lib/firebase-admin.ts` | `adminStorage()` + `Storage` imports removed (Firestore/Auth shim only) |
| `lib/workers/common.ts` | `downloadBytes`, `signedReadUrl`, `uploadBytes` now imported from `@/lib/storage` |
| `lib/server-deps.ts` | `downloadBytes` now imported from `./storage` (header comment updated) |
| `app/api/admin/[[...path]]/route.ts` | `signedPhotoUrls` now calls `signedReadUrl` from `@/lib/storage`; `storageBucket()` helper deleted |
| `app/api/cron/retention/route.ts` | Rewritten to `deletePrefix('raw/{listingId}/')` via Cloudinary bulk delete (slides/ still kept) |
| `lib/types.ts` | `storage_path` comment updated (logical path → Cloudinary `revault/listings/…`) |
| `.env.example` | Bucket var removed; Cloudinary block added |
| `storage.rules` | **Deleted** (`git rm`) |
| `test/rules.test.ts` | `storage.rules` assertion replaced with an explicit **does-not-exist** guard |
| `lib/storage.test.ts` | **New** — 15 tests with the Cloudinary SDK mocked |
| `package.json` | `cloudinary` npm package added (v2.11.0) |
| `SETUP.md` | Removed `storage.rules` deploy line + Firebase Storage setup step; added **§4b Cloudinary** (signup → dashboard → 3 env vars) |
| `AGENTS.md` | Rule 10 + storage architecture notes updated (private assets, `private_download_url`) |
| `BUILD_REPORT.md` | Swap recorded; morning checklist updated (Cloudinary keys, free-tier math, no storage.rules) |
| `implementation_plan.md` | Amendment note at top — plan's "Firebase Storage" mentions are historical |

## Docs re-verification (before coding)

Re-checked Cloudinary's official docs (2026-10-01,
`cloudinary.com/documentation/control_access_to_media.md`) and the installed
SDK v2.11.0 source (`node_modules/cloudinary/lib/utils/index.js`,
`node_modules/cloudinary/lib/api.js`):

- Server-signed uploads: `uploader.upload_stream` with a Buffer, params
  `{ public_id, resource_type: 'image', type: 'private', overwrite: true,
  invalidate: true, unique_filename: false }`.
- **Delivery:** `sign_url: true` on `cloudinary.url()` does NOT honour
  `expires_at` (verified in SDK source — it's only honoured by
  `utils.private_download_url(public_id, format, { expires_at })`). The
  official docs confirm `private_download_url` signs the Unix timestamp,
  public_id, format, type, attachment, and optional `expires_at` — so all
  delivery goes through `private_download_url`, ~4h default.
- Deletes: `uploader.destroy(public_id, { resource_type: 'image', type:
  'private', invalidate: true })` (missing → "not found", no throw); bulk
  `api.delete_resources_by_prefix(prefix, { resource_type: 'image', type:
  'private' })` for the retention cron.

## Deliberate design decisions

1. **Logical paths preserved.** Firestore `storage_path` values keep the exact
   existing format (`raw/{listingId}/{photoId}.jpg`, `slides/…`). Only
   `lib/storage.ts` maps them to Cloudinary public_ids
   (`revault/listings/raw/lst_abc/m_1` — extension stripped, slashes act as
   folders). Result: `lib/ingest.ts`, queue/worker code, and existing tests are
   **byte-for-byte unchanged**.
2. **Interface stability.** `downloadImageToStorage(url, destPath)` keeps its
   signature and all download guards (20s timeout, `image/*` content-type,
   15MB cap, `redactUrl`), so the ingest worker diff is zero.
3. **Private assets only.** `type: 'private'` on upload; nothing publicly
   reachable; every read via a time-limited signed URL generated on demand and
   never persisted — the same contract as the old signed GCS URLs.
4. **Config lazy.** SDK configured from env at first use (never import time),
   so unit tests and `next build` stay credential-free.
5. **`lib/images.ts` (sharp pipeline) untouched** — dHash duplicate detection
   + Gemini vision still need server-side bytes via `downloadBytes`.

## Test evidence

- **New: `lib/storage.test.ts` — 15/15 green.** Covers: `toPublicId` mapping
  (extension strip, leading slash), upload option contract (`public_id`,
  `resource_type: 'image'`, `type: 'private'`, `overwrite`), api_secret never
  in per-call options, download guards (non-image 415-path, >15MB, HTTP error,
  upload failure propagation), `signedReadUrl` default-4h and custom TTL via
  `private_download_url` params, `downloadBytes` short-URL fetch + failure,
  `deletePath` destroy params, `deletePrefix` bulk prefix, and
  `requireCloudinaryEnv` naming the missing var.
- **Full suite: 277/277 green** (21 files; baseline was 262/262: +15 new
  storage tests, −1 removed `storage.rules` assertion, +1 new explicit
  "storage.rules does not exist" guard).
- **`tsc --noEmit`: clean** (also verifies `type: 'private'` is a valid
  `UploadApiOptions` member).

## Known limitations / unverified

- Live `private_download_url` fetches by Meta's servers are
  **docs-verified but not runnable** without Cloudinary credentials — the
  morning checklist covers the first real end-to-end (`LIVE_TEST.md`).
- Delivering via `api.cloudinary.com` (vs CDN) costs ~2x bandwidth per
  Cloudinary's own docs — negligible at our volumes, but the reason bulk
  traffic (if any) would move to `type: 'authenticated'` + signed CDN URLs
  later.

## Morning-checklist delta for Asim

- NEW: sign up free at cloudinary.com → Dashboard →
  `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
  into Vercel env (secret stays server-only).
- REMOVED: `firebase deploy --only storage:rules` and the Firebase Console →
  Storage → Get started step.
- Everything else in the checklist is unchanged.
