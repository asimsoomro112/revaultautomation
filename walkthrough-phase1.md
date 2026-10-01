# Phase 1 Walkthrough — Webhook + Storage

**Date:** 2026-09-30 · **Owner:** Phase 1 (backend) subagent · **Status:** ✅ done — all deliverables built, tests green, Phase 1 files type-clean.

## What was built

| File | What it does |
|---|---|
| `lib/webhook.ts` | `verifySignature` (HMAC-SHA256 over raw bytes, `sha256=` prefix, `timingSafeEqual`), `verifyGetChallenge` (hub.mode/token/challenge), `parseWebhookPayload` (zod-validated `object:'instagram'` → `NormalizedInbound[]`; echo kept but flagged, text/image/quick_reply/unsupported/unknown mapping, per-attachment inbounds, malformed entries skipped without killing the batch) |
| `lib/db.ts` | Lazy firebase-admin singleton (`cert()` with `\n`-unescaping, `firebasestorage.app` default bucket + `FIREBASE_STORAGE_BUCKET` override); `db()`, `col()`, `storage()`; `claimWebhookMid` (Firestore transaction on `processed_webhooks/{mid}`, 7-day `expire_at`); `getOrCreateConversation`/`saveConversation`; `getListing`/`createListing`/`saveListing`/`blankListingDoc`/`appendListingEvent`; `getAdminSettings` (env-backed defaults: `publish_mode` etc. from env); `isBlocklisted` (+ `isSellerBlocklisted` alias); `findDuplicatePhash` → `string\|null` (+ `findDuplicatePhashEntry`, `findRecentPhashes`, `recordPhash` kept for Phase 3) |
| `lib/storage.ts` | `downloadImageToStorage` (20s timeout, 15MB streaming cap, content-type must be `image/*`, stores private as `image/jpeg`); `signedReadUrl` (v4, default 4h); `deletePath` (ignore-not-found) |
| `lib/qstash.ts` | `getQStashClient()`; `enqueueWorker(route, payload, {delaySec, notBefore, deduplicationId})` → `${APP_BASE_URL}/api/workers/<route>` via `publishJSON`; `verifyQStashSignature(req)` + `verifyQStashSignatureRaw({signature, body, url})` via `Receiver` (current + next keys); never throws |
| `lib/ingest.ts` | Zod schemas for all 5 `WorkerPayload` kinds + **pure `processIngest(payload, deps)`**: image → download NOW to `raw/{listingId}/{photoId}.jpg`, reuse active DRAFT or `lst_*`-new, record photo (w/h `0`, phash `''` — Phase 3 fills), conversation → COLLECTING, re-arm `finalize-photos` debounce (`deduplicationId: finalize-{listing}-{photo_at}`); text/quick_reply/unsupported → enqueue `message` worker (Phase 2 owns replies — **Phase 1 sends zero messages**); echo/unknown → log + ignore |
| `app/api/webhooks/instagram/route.ts` | GET → 200 raw challenge / 403. POST → raw body first, signature verify (401), parse, per message: skip echo → `enqueueWorker('ingest', …, {deduplicationId: mid})` → `claimWebhookMid`; 200 `{ok:true}`; internal error → 500 (Meta retries; claim+dedup-id make it idempotent) |
| `app/api/workers/ingest/route.ts` | Reads raw body once → QStash verify (401) → zod `WorkerPayload` (400) → `processIngest` with real deps (500 on failure → QStash retries) |
| `app/api/health/route.ts` | `{ok, version, ts, checks:{firestore, qstash, gemini, ig_token, publish_mode, ig_api_version}}` — degrades to `unconfigured`/`missing`, **never throws** without env |
| `test/fixtures/webhooks/*.json` | text, single-image, multi-image (2 entries), sticker, echo, video, quick-reply — realistic Meta shape |
| `scripts/replay-webhook.ts` | `--fixture <name\|all> --url …` signs raw fixture bytes with `IG_APP_SECRET` (env or test default), POSTs with `X-Hub-Signature-256`; `--verify` does the GET handshake check |
| `lib/{webhook,env,log,qstash,ingest}.test.ts` | 61 tests (see evidence) |
| `test/setup.ts` | Added dummy `QSTASH_*` keys (test-only) |
| `.env.example` | Existed from scaffold; fixed the storage-bucket comment to match the code default |

## Docs re-verification (before coding)

Re-checked via web: Meta webhook docs (GET `hub.mode=subscribe` + `hub.verify_token` → echo `hub.challenge`, else 403; POST `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256 over **raw body**, verify before parsing, timing-safe) and Upstash QStash JS docs (`Client.publishJSON({url, body, delay (s), notBefore (unix s), deduplicationId})`; `Receiver.verify({signature, body, url})` over raw text, HS256 JWT `iss=Upstash`, `body`=base64url(sha256), `sub`=url). **No contradictions with the brief — docs confirm it.** Also read the installed SDK source to confirm exact JWT claim semantics before writing signature tests.

## Deliberate deviations from the brief

1. **Webhook route: enqueue BEFORE claim** (brief said claim → enqueue). If the claim lands and the enqueue then fails, the 500 → Meta-retry path finds the mid already claimed and the message is silently dropped. Enqueue-first with `deduplicationId=mid` is strictly safer: a crash between the two steps is healed by redelivery, and duplicates are suppressed by both the QStash dedup id and the Firestore transaction.
2. **`findDuplicatePhash` returns `string \| null`** (brief) instead of the `DupEntry` shape the pre-existing partial `lib/db.ts` had — the fuller entry is kept as `findDuplicatePhashEntry` for the moderation pipeline, plus the `isSellerBlocklisted` alias. No consumer existed yet (`lib/moderation.ts` not present).
3. **New optional `FIREBASE_STORAGE_BUCKET` env** (not in plan §15) — Admin SDK `bucket()` throws without an explicit bucket; default is `<project>.firebasestorage.app` (correct for new projects). Documented in `.env.example`.
4. Route handler reads the raw body **once** and passes `{signature, body, url}` to `verifyQStashSignatureRaw`; `verifyQStashSignature(req)` is still exported per the brief.

## Test evidence

- **New Phase 1 tests: 61/61 green** — `webhook.test.ts` 24 (valid/invalid/tampered/missing/malformed signature, GET challenge 4 cases, all 7 fixture kinds + echo/unknown/garbage/malformed-batch), `qstash.test.ts` 11 (hand-crafted HS256 JWT vectors: current-key ok, next-key rotation ok, tampered body / wrong key / wrong url / expired / missing / garbage → false), `ingest.test.ts` 10 (photo create/reuse/new-after-status-change/mid-sanitising/missing-url, text+quick_reply+unsupported → message worker, echo/unknown ignored), `env.test.ts` 9 (all plan-§15 defaults, coercions, require* guards), `log.test.ts` 7 (phone/email/IGSID redaction, secret-key redaction, JSON lines).
- **Full suite: 176/176 green** (15 files; includes sibling phases' tests). One run showed 3 transient failures — a sibling agent was editing a file mid-run; reruns are clean.
- **`tsc --noEmit`: all Phase 1 files clean.** 16 errors remain, all in sibling-owned/in-flight files (see handoffs).
- **Live route smoke test** (`next dev`, no real creds): GET verify correct token → 200 + raw challenge; wrong token → 403; POST text fixture with valid signature → 500 `{ok:false,error:"internal"}` (proves signature passed and dispatch ran; 500 is correct without Firebase/QStash creds); POST with wrong secret → 401; `/api/health` → 200 with all checks degraded (`unconfigured`/`missing`); `/api/workers/ingest` with bogus/missing signature → 401. Replay script works end-to-end via `scripts/replay-webhook.ts`.

## Known limits & handoffs to Phase 2

1. **No messages are sent in Phase 1** — text/quick_reply/unsupported inbounds are enqueued for the Phase 2 message worker, which owns greetings, the polite "send photos as images" reply, intent, and language mirroring.
2. **Photo `w`/`h`/`phash` are `0`/`''`** in Phase 1 records — Phase 3's image pipeline fills them.
3. **`saveListing` is a shallow `Partial`** — Phase 4's in-flight `lib/workers/poll-container.ts` passes nested partial `publish` objects, which currently fails typecheck. Either switch `saveListing` to a `DeepPartial` or have callers reconstruct the full `publish` object. Flagging, not changing (sibling file in flight).
4. **Remaining `tsc` errors (16, not mine):** `lib/conversation.ts` ×5 (Phase 2), `lib/workers/poll-container.ts` ×4 (Phase 4), `lib/workers/idempotency.test.ts` ×4 (imports `MetaClient`/`ContainerStatus` from `@/lib/types` — they live in `lib/meta.ts`; Phase 4 test bug), `lib/meta.ts` ×1, `lib/tokens.ts` ×1 (Phase 5), `lib/log.ts` ×1 (pre-existing scaffold: spreading `unknown` in `emit`).
5. **Contracts evolved mid-build:** a sibling extended `types.ts` — `ConversationDoc` gained `user_msg_total`/`last_processed_mid`, `ListingDoc` gained `chat_text` and `publish.container_status`/`locked_until`. `blankConversation`/`blankListingDoc` and the ingest test fakes were updated to match; `enqueue` opts type widened for `exactOptionalPropertyTypes`.
6. **Ops notes for Phase 6 SETUP.md:** `processed_webhooks.expire_at` needs a Firestore TTL policy in the console; `admin_settings/global` is auto-created with env defaults on first read; default bucket is `<project>.firebasestorage.app`.
7. **Concurrent workspace:** sibling agents are editing shared files live (`lib/db.ts`, `lib/types.ts` were both touched mid-build). Re-run `tsc` + tests before merging anything.
8. Not committed (per instructions — coordinator owns git). No real secrets used anywhere; tests use `test/setup.ts` dummies.
