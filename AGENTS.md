# AGENTS.md — ReVault DM-to-Post Bot

Working rules for anyone (human or agent) touching this repo. Short on purpose.

## Non-negotiables

1. **Official Meta APIs only.** No scraping, no unofficial clients, no browser
   logins. Instagram API with Instagram Login via `https://graph.instagram.com`,
   `IG_API_VERSION` env (default `v26.0`).
2. **Secrets via env only.** Never commit `.env*`, keys, tokens, or service-account
   JSON. The pre-commit hook blocks them; CI must also run a secret scan.
3. **Webhook:** GET challenge + HMAC-SHA256 over **raw body bytes**
   (`X-Hub-Signature-256`, timing-safe compare) → enqueue to QStash → **200 fast**.
   Dedupe every inbound on `mid` (`processed_webhooks`, TTL on `expire_at`).
4. **Moderation is fail-closed.** Blocklist/dup → REVIEW/FAIL per `lib/moderation.ts`.
   Any exception anywhere in the safeguard chain → REVIEW, never PASS.
5. **Kill switch before every publish step.** `admin_settings.global_kill_switch`
   is re-read in `publish`, `poll-container`, and before `media_publish`.
6. **No sends outside the 24h messaging window.** `sendSafe` enforces it.
   Never use the `HUMAN_AGENT` tag (human-agents-only policy).
7. **Idempotency:** listing id is the idempotency key. `media_publish` at most once
   per listing. QStash messages carry `deduplicationId`.
8. **PII:** redact phone/email/address at the log boundary (`lib/log.ts`).
   Meta CDN URLs are never persisted — download bytes to private Storage NOW.
9. **Gemini:** model from `GEMINI_MODEL` env (default `gemini-3-flash-preview`,
   verified working 2026-11-23 — `gemini-3.8-flash` AND `gemini-3.7-flash`
   both returned 503 "high demand" that day). `extractListing` retries
   transient 503/429/5xx in-line (2s, 4s backoff) ROTATING through the fallback
   chain in `GEMINI_FALLBACK_MODELS` (default `gemini-3.6-flash,gemini-3.5-flash`
   — both verified answering 2026-11-23; `gemini-3.1-pro-preview` has 0
   free-tier quota on this key, so it is NOT a fallback). On first use per
   serverless instance the client asks Google for the LIVE model list
   (`ai.models.list`) and drops any configured model no longer listed; if the
   list call fails, the configured chain is used unchanged. The list proves
   existence, not health — a listed model can still 503; the rotation handles
   that at call time. `classifyIntent`/`writeCaption`/`chatReply` try each
   model once in order. **Never `gemini-2.5*`** — `lib/gemini.ts` refuses it
   (family retires 2026-10-16). Re-verify the model list at
   ai.google.dev/gemini-api/docs/models before changing the default.
10. **Firestore deny-all** except the `admin` custom claim (`firestore.rules`).
    Photos live in **Cloudinary**, not Firebase: server-signed uploads into
    `revault/listings/` as `type: 'private'` assets; delivery via
    time-limited `private_download_url` (~4h, never persisted).
    `/admin` = Google sign-in + claim check.
11. **Strict TypeScript** (`exactOptionalPropertyTypes`), **zod at every boundary**
    (webhook payloads, worker payloads, admin bodies, Gemini outputs).
12. **Tests are the gate.** No phase/file is "done" until `npm test` is green and
    `npx tsc --noEmit` is clean. New behavior ships with tests (mocks in
    `lib/test-fakes.ts`; never hit network in tests).

## Commands

```bash
npm install
npm test                    # vitest, 326 tests, fully mocked
npx tsc --noEmit            # strict typecheck
npm run dev                 # next dev
npm run replay -- --fixture multi-image-burst --verify   # scripts/replay-webhook.ts
npm run grant-admin -- you@gmail.com                     # set admin claim
```

Workflow: `.agents/workflows/verify.md` (lint → typecheck → test).

## Architecture notes

- All async waiting is **delayed QStash messages** (`notBefore`/delay), never
  `setTimeout` in serverless. Workers: `ingest` → `finalize-photos` (25s debounce)
  → `message` → `publish` (PKT slot) → `poll-container` (backoff 30s→300s).
- `lib/db.ts` is the **single Firebase Admin init** (Firestore only since the
  2026-10-01 Cloudinary swap). `lib/firebase-admin.ts` is a thin shim — new code
  imports from `@/lib/db`.
- `lib/storage.ts` is the **single photo-storage module** (Cloudinary):
  `downloadImageToStorage` (CDN fetch NOW + signed upload), `uploadBytes`,
  `downloadBytes`, `signedReadUrl` (~4h `private_download_url`), `deletePath`,
  `deletePrefix` (retention). Logical paths (`raw/…`, `slides/…`) map to
  public_ids `revault/listings/…`. `api_secret` never leaves the server.
- `lib/moderation.ts` **reads** the duplicate index; `handleFinalizePhotos`
  **writes** it (`recordPhash` after moderation, every verdict).
- Publish slides: EXIF-rotate → blurred self-fill background + contain-fit
  foreground → 1080×1350 sRGB JPEG q85, metadata stripped (`lib/images.ts`).
- Cover slide only when `brandAssetsAvailable()` (needs `/brand/colours.json` +
  logo) AND `COVER_SLIDE_ENABLED=true`. **Never invent brand assets.**
- Signed URLs: ~4h expiry via Cloudinary `private_download_url` (`expires_at`),
  generated on demand, never persisted. Dead containers are recreated, never
  reused.
- `PUBLISH_MODE`: `review` (default) | `auto` | `dry_run`.

## Don't

- Don't change shared contracts (`lib/types.ts`, `DbPort`, worker payloads)
  without updating all producers/consumers + tests.
- Don't add a new env var without `.env.example` + `lib/env.ts` zod schema.
- Don't send Telegram alerts that throw — `notifyAdmin` never throws by design.
- Don't widen Firestore rules for convenience; use the admin claim.
- Don't "fix" a failing test by weakening the assertion — fix the code.
- Don't import JSX element objects out of a `"use client"` module into a
  Server Component — they render nothing, silently (2026-11-23: the
  dashboard home cards lost all icons). Keep shared icons/elements in a
  plain module with no `"use client"` — see `app/admin/components/navIcons.tsx`.

## Burst race (2026-11-23 — Nina, lst_a5fa2b817b16)
- A seller's burst (3 photos + video + 2 texts within seconds) runs as
  concurrent QStash jobs. The old read-modify-write pattern (getListing →
  append in memory → saveListing whole array) LOST updates: 3 photos → 1
  survived, and a details text could be clobbered the same way.
- RULE: any listing write whose new value derives from the current doc
  (photos array, chat_text, extracted) MUST go through `mutateListing`
  (Firestore transaction, lib/db.ts). Narrow merge patches of independent
  fields (status, caption, moderation) are already atomic per-field.
- Listing find-or-create is transactional too (`getOrCreateActiveListing`) —
  concurrent first photos must not each create their own listing.
- Photos arriving while NEEDS_INFO append to the SAME listing (ingest reuses
  DRAFT or NEEDS_INFO).
- A multi-line details dump ("Brand: …\nDiscounted price: 2k\n…") arriving in
  NEEDS_INFO is parsed field-by-field (`parseDetailsDump`, lib/conversation.ts);
  "2k" prices coerce to 2000, discounted price wins over original price.
- Finalize retries transient failures (retryable GeminiError, download/network)
  twice, 60s apart, before failing closed to NEEDS_REVIEW — a 503 spike must
  not strand a listing with nothing extracted.
- Tests: `npm test` is 326 tests (23 files); the burst test fails without the
  transaction locks (verified by temporarily removing them).

## Burst combine (2026-11-23 — live test, lst_84dd9f3355b3)
- The transaction fix shipped, but the live test (3 photos + details text)
  still landed as 1 photo, no extracted fields, NEEDS_REVIEW. Diagnosis:
  extraction ran on the photos alone — the details text arrived after the
  photos (and possibly mid-extraction) and was never combined into it; a
  finalize on an empty photo list used to fail closed ("no image buffers",
  non-retryable) instead of skipping.
- RULE: the bot now treats a seller's burst as ONE submission.
  `last_activity_at` (ListingDoc) is bumped by every photo append AND every
  text/dump/answer mutate. A text on a listing with photos re-arms
  finalize-photos with a fresh `activity_at` (see `rearmFinalizeForText`,
  lib/conversation.ts). Finalize skips when `activity_at` moved on, skips
  when the listing has no photos, and re-checks activity AFTER extraction —
  if anything arrived during the vision call, the result is discarded and
  finalize re-arms (max 4 re-arms, then it proceeds).
- A failed CDN download re-enqueues the ingest itself (attempt+1, 30s, max
  2 — `IngestPayload.attempt`), so a transient failure cannot silently lose
  a burst photo. The append stays idempotent on storage_path.
- Tests: the burst-combine tests fail without the activity guards (re-check
  discard, re-arm cap, no-photos skip, download self-retry).

## Activity feed 500 (2026-11-23 — Asim's Log screenshot, FAILED_PRECONDITION)
- GET /api/admin/activity 500d: `collectionGroup("events").orderBy("at","desc")`
  needs a COLLECTION_GROUP_DESC composite index for collection `events` +
  field `at` (Firestore: "The query requires a COLLECTION_GROUP_DESC index
  for collection events and field at"). The old code comment claiming
  "collectionGroup + single-field orderBy needs no composite index" was
  wrong, and firestore.indexes.json has no events index (only listings
  status+created_at — also still undeployed).
- FIX: the endpoint no longer uses collectionGroup — it lists listings
  (orderBy created_at desc, limit 50), reads each listing's events
  (orderBy at desc, limit 10) and merges newest-first in memory (same
  pattern as the queue endpoint; single-collection orderBy uses the auto
  single-field index, so no index deploy is needed). The feed now also
  surfaces `photo_count` on finalized events (the number that decides
  whether a burst's photos all reached extraction).
- Test: the admin-api mock's collectionGroup THROWS now, so any future
  use fails the test instead of prod.
- Follow-up (2026-11-23 ~23:51): the feed also surfaces the event's
  `error` + `attempt` (finalize_retry events carry those, not `detail`) —
  the retry's exact error is now readable in the Detail column.

## Worker signature verification (2026-11-24 — overnight audit)
- All 5 worker routes verified QStash signatures against `req.url` directly
  (`verifyQStashSignatureRaw`). The safe helper `verifyQStashSignature`
  (rebuilds the signed URL from APP_BASE_URL — req.url can differ behind
  Vercel/proxies) existed, was tested, but was unused by any route. A
  mismatch 401s the job; QStash never retries 4xx, so the job is lost
  silently with only a warn log and no error — the silent-drop signature.
- FIX: new helper `verifyQStashSignatureWithBody(req, rawText)` (same
  rebuild, for routes that already read the body); all 5 worker routes use
  it. Tests: the proxy-URL case fails on the old code path.

## Claude audit fixes (2026-11-23)
- **Test clock:** `sendSafe` (and any 24h-window check) must use the injected
  clock — `isWithinWindow(x, Date.parse(deps.now()))` — never `Date.now()`.
  Fixtures are pinned to 2026-09-30; the real clock made 18 tests fail once
  that date aged past 24h. Fixed 2026-11-23: 292/292 green.
- **Lint:** flat `eslint.config.mjs` (eslint-config-next core-web-vitals +
  typescript). `npm run lint` is `--max-warnings=0`; `_`-prefixed args are
  ignored by config; mount-fetch effects carry a documented
  `react-hooks/set-state-in-effect` disable.
- **Firestore indexes:** `firestore.indexes.json` (+ `firebase.json` ref) —
  listings (status ASC, created_at ASC) for retention/reconcile ranges and
  (status ASC, created_at DESC) for the publish-log orderBy. Deploy with
  `firebase deploy --only firestore:indexes`.
- **Crons:** vercel.json schedules token-refresh 03:00, retention 03:30,
  reconcile 04:00 daily (Hobby plan = daily only).
- **Secrets:** `scratch/` is gitignored; the pre-commit hook blocks `IGAA…`
  tokens and `service[- ]account*.json`. Never commit scratch files.
- **Next.js:** 16.4.6 (upgraded from 16.3.8 for the Oct 14 critical RCE/DoS
  fixes). Upgrade with plain `npm install next@latest` — never `--force`
  (it would downgrade Firebase to v9).

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
