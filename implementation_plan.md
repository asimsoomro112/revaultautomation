# ReVault DM-to-Post Bot — Implementation Plan

**Project:** `~/workspace/revault-dm-bot/` — production-grade Instagram DM-to-Post automation for **@therevaultofficial** (ReVault preloved fashion marketplace, revaultx.vercel.app)
**Status:** 🟢 APPROVED by Asim 2026-09-30 22:01 PKT — full autonomous build authorized (plan + code), ~8h window while he sleeps.
**Keys note:** Meta app, Gemini, Firebase, QStash, Telegram credentials to be provided by Asim in the morning — build runs on env vars + mocks until then.
**Date:** 2026-09-30 | **Mode:** Planning (Phase 0)

> **AMENDMENT 2026-10-01 (post-build):** photo storage moved from Firebase
> Storage to **Cloudinary** on Asim's instruction. Firestore (database) and
> Firebase Auth (admin login) are unchanged — both stay on the free tier.
> Everything in this plan that says "Firebase Storage" for photos now means
> Cloudinary (`revault/listings/` folder, `type: 'private'` assets, signed
> `private_download_url` delivery ~4h, never persisted). New env:
> `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
> (replacing `FIREBASE_STORAGE_BUCKET`); `storage.rules` deleted. Full
> details in `walkthrough-storage-cloudinary.md`.

---

## 1. What I verified in the official docs today (docs win over this prompt)

I read the current Meta + Google docs via the browser before writing this plan. Key findings that shape the design:

| # | Finding | Source |
|---|---------|--------|
| 1 | **Latest Graph API is `v26.0`** (released 2026-07-29). Pin via `IG_API_VERSION`; default `v26.0` (v25.0 supported until 2028-07-29 as fallback). | Meta changelog |
| 2 | **Quick replies are supported** on Instagram Messaging: max 13, title ≤ 20 chars, plain text only, **not available on desktop**. Webhook echoes `quick_reply.payload`. → We get consent buttons, but must also accept typed fallbacks ("post", "1", etc.) for desktop users. | Meta quick-replies doc |
| 3 | **Carousel publishing flow**: child containers (`is_carousel_item=true`) → parent (`media_type=CAROUSEL`, `children=…`) → poll `status_code` → `media_publish` → permalink. **All slides are cropped to the FIRST slide's aspect ratio** → normalising every slide to one 4:5 canvas is mandatory, not cosmetic. | Meta/community flow refs |
| 4 | **`image_url` must be a public HTTPS URL that stays live through async container processing** — "no short-TTL signed URLs". → **Prompt refinement:** signed URLs will carry a **4-hour expiry** (not "short-lived"), and any container that hits ERROR/EXPIRED is recreated with a fresh URL. Never persisted; generated on demand. | Publishing playbook |
| 5 | **Quota: Meta is mid-transition from 50 → 100** API posts / rolling 24h. **Trust `content_publishing_limit`, never a hardcoded number.** Our own limits (6/day, 90-min gap) are far stricter anyway. | Quota note |
| 6 | **24h messaging window is API-enforced.** Every user message resets the clock. The `HUMAN_AGENT` tag (7-day window) exists but is **strictly for real human agents — automated use is blocked as a policy violation**. → We will NOT use it; outside the window we mark the conversation and wait, exactly as specified. | Policy guide |
| 7 | **Gemini model:** the 2.5 family retires 2026-10-16 (per your note — accepted). Current stable non-2.5 models include `gemini-3.5-flash`, `gemini-3.6-flash`, `gemini-3.8-flash` (GA 2026-09-02), `gemini-3.1-flash-lite`. → **Default `GEMINI_MODEL=gemini-3.8-flash`** (current stable flagship per Google docs, re-verified 2026-09-30; `gemini-3.5-flash` now marked "legacy". Vision-capable, structured output; per-listing volume is tiny so cost delta is negligible). Never hardcoded — env only, env-revertible. | Model research (re-verified 2026-09-30) |
| 8 | **Tokens (Instagram API with Instagram Login):** dashboard issues short-lived (~1h) → exchange for 60-day long-lived via `GET graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=…&access_token=…`; refresh via `GET graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=…` (only when token is ≥24h old). **Host is `graph.instagram.com`** (Path A), not `graph.facebook.com`. | Token guides |
| 9 | **Webhook security:** GET handshake (`hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`) + `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256 over the **raw body bytes** (verify *before* JSON parsing — re-serialising breaks it), timing-safe compare, **200 fast, work async**. Meta retries with backoff for many hours → dedupe mandatory. | Webhook refs |
| 10 | **"Self Messaging" is a documented testing path** — the professional account can message itself, so LIVE_TEST.md needs no second account. | Meta self-messaging doc (found in docs index) |
| 11 | **Rate limit ≈ 200 API calls/hour** on the Instagram API → outbound sends go through a small sender queue with backoff, not direct fire-and-forget. | Setup checklist |

**Where docs refined your prompt:** (a) signed URLs get 4h TTL, not "short-lived"; (b) HUMAN_AGENT tag will NOT be used (human-only policy); (c) quota read live from the endpoint; (d) quick replies need typed fallbacks for desktop; (e) `GEMINI_MODEL` defaults to `gemini-3.5-flash`, verified at build.

---

## 2. Architecture

```
Seller DM ──▶ Meta ──▶ POST /api/webhooks/instagram (Vercel, Node)
│ 1. verify X-Hub-Signature-256 (raw body, timing-safe)
│ 2. dedupe on message id (processed_webhooks)
│ 3. enqueue → 200 OK (< 1s)
▼
Upstash QStash ──▶ /api/workers/ingest (async, signed)
│ download image bytes NOW → Firebase Storage (never persist CDN URL)
│ update conversation/listing state, (re)schedule debounce
▼
QStash delayed 25s ──▶ /api/workers/finalize-photos
│ if no newer photo → Gemini vision call (ONE call: moderation + extraction)
▼
moderation PASS → NEEDS_INFO (one consolidated question, quick replies)
│ REVIEW → admin queue + Telegram alert
│ FAIL → polite rejection with reason
▼
CONFIRM: preview + consent quick replies (Post/Edit/Cancel)
│ consent stored (timestamp + message id)
▼
SUBMITTED → schedule publish slot (QStash notBefore)
▼
/api/workers/publish (at slot): kill-switch check → quota check →
build 1080×1350 JPEGs → signed URLs (4h) → containers →
poll FINISHED (QStash delayed backoff) → media_publish → permalink
│ DM seller the permalink · failure → neutral DM + Telegram alert
▼
/admin (Firebase Auth, allowlist) — queue, review, publish log, quota gauge, kill switch, token health
```

**Why this shape:** Vercel serverless has no long-running processes, so *all* waiting (photo debounce, container polling, publish slots) is expressed as **delayed QStash messages** — each worker invocation is short and idempotent. Vercel Cron handles the two daily jobs (token refresh, media retention cleanup).

---

## 3. Stack decisions (with justification)

| Choice | Decision | Why |
|--------|----------|-----|
| Framework | **Next.js (latest stable at scaffold, App Router) + TypeScript strict** | As specified. Route handlers for webhooks/workers/cron/admin API; React for /admin. |
| Async/queue | **Upstash QStash for delayed + retryable jobs; Vercel Cron for daily schedules** | QStash gives delay-in-seconds (photo debounce 25s, poll backoff, exact publish slots), retries, DLQ, and signature verification — Vercel Cron can't do sub-minute or one-shot delayed delivery. Cron is fine for daily token refresh + retention cleanup. |
| DB/Auth/Storage | **Firebase: Firestore + Storage + Admin SDK + Firebase Auth (Google)** | As specified. Single vendor for data, private media, and admin auth. |
| AI | **`@google/genai`, `GEMINI_MODEL` env (default `gemini-3.5-flash`)** | One multimodal call per listing (moderation + extraction together) minimises cost/latency; structured JSON output validated by zod. Caption is a second cheap text call only for PASS/REVIEW listings. |
| Images | **sharp** | EXIF auto-orient, sRGB JPEG, metadata strip, contain-fit on blurred background, dHash for duplicates, satori→sharp for the optional cover slide. No extra deps. |
| Validation | **zod** | Extraction schema, webhook payloads, env parsing (`zod` + `process.env` guard at boot). |
| Tests | **vitest** + recorded fixtures + `scripts/replay-webhook.ts` | Unit (signature, state machine, schemas, schedule math, idempotency) + fixture replay + mocked Meta/Gemini for CI. |
| Alerts | **Telegram bot (dedicated ReVault bot)** | You already live on Telegram (signal-bot alerts go there); instant, no SMTP/deliverability overhead. One bot, one admin chat. Justification as requested. |
| Duplicate detection | **dHash (8×8) via sharp, Hamming distance in Firestore** | No new service; good enough for catching reposted listing photos. Threshold tuned in Phase 3. |

**Deviations from your spec:** none structural. Two refinements noted in §1 (signed-URL TTL, no HUMAN_AGENT tag).

---

## 4. Data model (Firestore)

```
admin_settings (doc: global)
  global_kill_switch: bool
  publish_mode: "review" | "auto" | "dry_run"      // default "review"
  max_posts_per_day: 6 · min_gap_minutes: 90
  posting_window: { start: "12:00", end: "23:00", tz: "Asia/Karachi" }
  max_listings_per_seller_per_day: 5 · photo_debounce_seconds: 25
  retention_days: 30 · caption_cta: "dm" | "site"
  cover_slide_enabled: false                        // until brand assets arrive
  faq_buyer: string                                 // buyer FAQ, editable in /admin
  token: { enc: string (AES-256-GCM), expires_at, updated_at }   // IG long-lived token, encrypted
  ig_user_id: string

conversations/{igsid}
  state: "IDLE" | "COLLECTING" | "NEEDS_INFO" | "CONFIRM"
  lang: "ur" | "roman" | "en"                       // mirrored language
  active_listing_id: string | null
  listings_today: number · listings_day: "2026-09-30"
  window_open: bool · last_user_msg_at: timestamp
  human_needed: bool · blocked: bool
  msg_count_1h: number                              // spam guard

listings/{listingId}                                // id = idempotency key
  seller_igsid · created_at · status:
    "DRAFT" | "NEEDS_INFO" | "CONFIRM" | "SUBMITTED" | "NEEDS_REVIEW"
    | "APPROVED" | "QUEUED" | "PUBLISHING" | "PUBLISHED" | "REJECTED" | "FAILED"
  photos: [{ storage_path, w, h, phash, received_at }]   // CDN URLs NEVER stored
  extracted: { title, category, gender, brand|null, color, size, condition,
               price_pkr, city, defects[], measurements, confidence{field: 0..1} }
  moderation: { verdict: "PASS"|"REVIEW"|"FAIL", reasons[], per_image[] }
  caption: string · consent: { at, message_id } | null
  publish: { slot_at, container_ids[], media_id, permalink, attempts, last_error }
  review: { note, decided_by, decided_at } | null

listings/{id}/events/{autoId}                       // append-only audit trail

processed_webhooks/{mid}  { at, expire_at }         // webhook dedupe (TTL 7d)
phash_index/{dhash}       { listing_id, at }        // duplicate detection
blocklist/{igsid}         { reason, at, by }
counters/daily_posts/{yyyy-MM-dd} { count }         // PKT day
counters/daily_listings/{igsid}/{yyyy-MM-dd} { count }
```

**Firestore rules:** `deny all` client reads/writes except authenticated users whose custom claim `admin == true` (set by a one-time setup script for ADMIN_EMAILS). **Storage:** private; all access via Admin SDK; Instagram fetches via 4h signed URLs.

**State machine (your spec, refined):** the *conversation* carries the dialogue state (`IDLE → COLLECTING → NEEDS_INFO → CONFIRM`); the *listing* carries the pipeline status. Mapping to your names: `SUBMITTED` = consent given; `PUBLISHED | REJECTED` terminal. Extra internal states (`NEEDS_REVIEW`, `APPROVED`, `QUEUED`, `PUBLISHING`, `FAILED`) exist so the admin UI and queue can reason precisely — they collapse to your seven for reporting. Guards: `CONFIRM` requires ≥2 photos + category + size + condition + price + city; `SUBMITTED` requires consent record; publish requires kill-switch off + mode != dry_run + moderation PASS (+ admin approval unless mode=auto).

---

## 5. Webhook endpoint — `POST /api/webhooks/instagram`

1. **GET verification:** if `hub.mode == "subscribe"` and `hub.verify_token == IG_VERIFY_TOKEN` → return raw `hub.challenge` with 200; else 403. (Never echo without checking.)
2. **POST:** read the **raw body bytes first** (`req.arrayBuffer()` before any JSON parse — Next.js App Router does not pre-parse if we read the stream ourselves; use `export const dynamic = 'force-dynamic'` and avoid body-parser interference).
3. Verify `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256(raw, IG_APP_SECRET), `crypto.timingSafeEqual`. Fail → 401, log (no PII), alert counter.
4. For each `entry[].messaging[]`: skip if `message.is_echo` (our own sends); extract `mid`, `sender.id` (IGSID), `message.text | attachments[] | quick_reply.payload`, `timestamp`.
5. **Dedupe:** Firestore transaction on `processed_webhooks/{mid}` — if exists, 200 and stop. (Meta retries for many hours on non-200.)
6. Enqueue QStash `ingest` (signed, with `deduplicationId = mid`) → **return 200 immediately** (target < 800ms).

**`POST /api/workers/ingest` (QStash-signed, verified via Upstash signature):**
- Text → conversation engine. Image attachment → **download bytes immediately** (`fetch(payload.url)` → Firebase Storage `raw/{listingId}/{photoId}.jpg`) → update listing photos + `last_photo_at` → (re)schedule QStash delayed `finalize-photos` (+25s) carrying `{listingId, photoAt}`; on fire, skip if `last_photo_at != photoAt` (a newer photo re-armed the timer).
- Sticker/gif/video/audio/unsupported → polite reply ("Photos as images bhej dein…"), no listing progress.
- Keyword `human` (any language variant) → `human_needed = true` + Telegram alert, warm handoff message.
- **24h window:** `window_open = (now - last_user_msg_at) < 24h`, refreshed on every inbound. Outbound send helper refuses when closed → marks conversation, waits for next inbound.

---

## 6. Conversation engine — `POST /api/workers/message`

- **Intent first (Gemini text call, cached per conversation):** `SELLER_SUBMIT` vs `BUYER_QUESTION` vs `OTHER`. Buyers → short FAQ (`admin_settings.faq_buyer`) + CTA (DM to buy / revaultx.vercel.app), no listing. Sellers → greeting: who the bot is, what's needed (2+ clear photos, size, condition, price, city), **warning that posts are public**.
- **Language mirror:** detect `ur` (Urdu script) / `roman` / `en` from the first 2 user messages; store; every Gemini prompt carries "reply in {lang}"; default friendly Roman-Urdu + English mix, short messages (≤ 2 bubbles per turn).
- **Extraction (ONE Gemini vision call per finalize):** all listing photos + accumulated chat text → zod schema `{moderation, extracted, confidence, missing[]}`. **Never hallucinate brand/size/price:** schema forces `brand: null` unless a tag/logo is visible; low-confidence fields → `missing[]`.
- **NEEDS_INFO:** exactly ONE consolidated question per round; enums (condition, category, gender) go as quick replies (≤20 chars) **plus** a typed fallback line ("ya likh dein: new / like-new / used") for desktop users where quick replies don't render.
- **CONFIRM:** send first-slide preview image + details summary + caption draft, then consent quick replies: `Post it` / `Edit` / `Edit caption`… (payload-tagged). Consent text states: photos + details become **public**, the bot **cannot delete** posts, removal requests go to the admin. Store `{at, message_id}`. Edit → loop back to NEEDS_INFO for that field; Cancel → listing REJECTED (polite close).
- **Rate limits:** `max_listings_per_seller_per_day` (default 5, PKT day); >12 msgs/hour from one seller → warning, then temporary ignore with admin flag; repeat offenders → blocklist (admin can unban).
- **Gemini call budget per listing:** 1 intent + 1 vision (moderation+extraction) + ≤2 NEEDS_INFO follow-ups (text-only, cheap) + 1 caption. No per-photo calls.

---

## 7. Moderation (fail closed)

Every finalize runs this verdict (same Gemini vision call, separate zod object — one call, two schemas):
`is_clothing`, `nudity_sexual`, `visible_faces`, `minors`, `offensive_text`, `contact_info` (phone/email/address in image OR text), `counterfeit_claims` ("first copy", "replica", brand mismatch vs visible tag), `stock_or_stolen_suspicion`, plus **dHash duplicate check** vs `phash_index` and the **seller blocklist**.
- **PASS** → continue. **REVIEW** → `NEEDS_REVIEW` + Telegram alert with preview link (faces, uncertain brand, possible stock image). **FAIL** → polite rejection naming the reason category (no lecture), listing REJECTED.
- **Any error** (Gemini timeout, schema violation, download failure) → treat as REVIEW (fail closed), never auto-pass.

---

## 8. Image pipeline — `lib/images.ts`

1. Input: raw bytes in Storage (`raw/{listingId}/{photoId}.jpg`).
2. `sharp`: `.rotate()` (EXIF orientation), convert to **sRGB JPEG** (`.toColorspace('srgb')`, `.jpeg({quality: 85, mozjpeg: true})`), **strip all metadata** (never call `.withMetadata()` → GPS gone).
3. Resize to **1080×1350 (4:5)** via contain-fit: resize photo to fit inside 1080×1350, then composite over a **blurred, darkened copy of itself** filling the canvas (two-pass sharp). **Never crop the clothing.** Every slide gets the identical canvas → satisfies the first-slide-locks-ratio rule.
4. Optional **cover slide** (satori → SVG → sharp → JPEG 1080×1350): logo, price PKR, size, condition. Gated by `cover_slide_enabled` — **stays OFF until you provide logo/colours/voice** (see questions). `/brand/` ships with a README placeholder, not invented assets.
5. Upload processed slides to `slides/{listingId}/{n}.jpg` (private). Generate **4h signed URLs on demand** for container creation only.
6. **Retention:** daily cron deletes `raw/` originals `RETENTION_DAYS` (30) after publish; processed slides are the published artifact and are kept (cheap, and needed for reposts/appeals).

## 9. Caption — `lib/caption.ts`

Gemini writes **only from the zod-verified `extracted` object** (never from raw chat): hook line → details (brand — only if non-null, size, condition, price PKR) → honest defects line (or "no visible defects stated") → CTA (env `caption_cta`: "DM to buy 🤍" or `revaultx.vercel.app` link) → 3–5 relevant hashtags (`#prelovedpakistan` style, derived from category/city). **No seller personal info, ever.** Tone follows `/brand/voice.md` (you provide or approve my draft). ≤ 2200 chars, ≤ 30 hashtags (we use ≤ 5).

---

## 10. Publishing engine — `POST /api/workers/publish`

**Slot computation (`lib/schedule.ts`, Asia/Karachi):**
```
slot = now
if count(posts today PKT) >= MAX_POSTS_PER_DAY → slot = tomorrow 12:00
slot = max(slot, last_publish_at + MIN_GAP_MINUTES)
if slot > window_end → slot = next day 12:00
if slot < window_start → slot = today 12:00
```
Containers are created **at slot time** (they expire after 24h), so the queue stores `{listingId, slot_at}` and QStash `notBefore = slot_at`.

**Publish steps (each step re-reads the kill switch + idempotency record first):**
1. `GLOBAL_KILL_SWITCH` on → park job (`QUEUED`, `last_error: "killed"`), Telegram alert, stop. Checked before container creation, before each poll, and before `media_publish`.
2. `GET /{ig-user-id}/content_publishing_limit` → abort to next day if Meta quota exhausted (log; reschedule).
3. Create child containers: `POST /{ig-user-id}/media {image_url: <4h signed URL>, is_carousel_item: true}` (single photo → plain image container with caption). Store container ids on the listing.
4. Poll `GET /{container-id}?fields=status_code` via QStash delayed retries (30s → 60s → 120s, timeout 15 min). On `ERROR`/`EXPIRED` → **recreate that container** with a fresh signed URL (never reuse a dead container id).
5. Parent: `POST /{ig-user-id}/media {media_type: CAROUSEL, children: [...], caption}` → poll `FINISHED`.
6. `POST /{ig-user-id}/media_publish {creation_id}` → `GET /{media-id}?fields=permalink` → listing `PUBLISHED`.
7. DM the seller the permalink 🎉. On failure → neutral DM ("technical issue, team is on it") + Telegram alert with error + listing `FAILED` (admin can retry from /admin; retry reuses the idempotency record — **never double-posts**).

**Idempotency:** listing id is the idempotency key; every step checks stored `container_ids`/`media_id` before calling Meta; QStash messages carry `deduplicationId`. Two workers can never publish the same listing twice.

**`PUBLISH_MODE`:** `review` (default — every PASS listing waits in /admin for Approve), `auto` (PASS publishes at next slot; REVIEW/FAIL always need admin), `dry_run` (full pipeline, stops before `media_publish`, logs what would happen).

---

## 11. Admin — `/admin` (Next.js App Router)

Firebase Auth **Google sign-in**; `ADMIN_EMAILS` allowlist → one-time script sets custom claim `admin: true`; Firestore/Storage rules enforce it. Pages:
- **Queue:** live list (PENDING review / scheduled / publishing) with photo carousel preview, caption (editable), extracted data, moderation verdict + reasons.
- Actions: **Approve / Edit caption / Reject with reason / Ban seller / Retry failed**. All actions append to the listing's `events` log.
- **Publish log** (permalink, time, seller, latency), **quota gauge** (today's count vs MAX_POSTS_PER_DAY + Meta's `content_publishing_limit`), **kill switch** (big red toggle, confirms, logs + Telegram alert), **token health** (expiry date, last refresh, refresh-now button).
- Review-needed and failure alerts also push to Telegram instantly.

---

## 12. Tokens & ops

- **Storage:** long-lived IG token encrypted with **AES-256-GCM** (`IG_TOKEN_ENC_KEY` from env, 32 bytes) in `admin_settings.token`; plaintext never logged, never in Firestore unencrypted. (Vercel env is encrypted at rest; this is the second layer your spec asked for.)
- **Refresh:** Vercel Cron `0 3 * * *` → `/api/cron/token-refresh`: if `expires_at - now < 7 days` (and token ≥ 24h old) → `refresh_access_token` → re-encrypt + store. Failure → Telegram alert immediately + `token_health: "degraded"` in /admin.
- **Health:** `GET /api/health` → `{ ok, firestore, qstash, gemini, ig_token_expires_in_days }` (no secrets).
- **Logs:** structured JSON; PII redaction (phone/email/address regex → `[redacted]`) at the log boundary; IGSIDs stored as-is in Firestore (needed for ops) but truncated in logs.
- **Secrets:** `.env.example` documents everything; `.env*` gitignored; **no secret ever committed** — pre-commit hook (`detect-secrets` or `gitleaks`) in Phase 6.

---

---

## 13. Testing (required, built in — not bolted on)

- **Unit (vitest):** signature verify (valid/invalid/tampered/missing header, timing-safe), state-machine transitions + guards (incl. illegal jumps), zod schemas (extraction, moderation, webhook payload — incl. adversarial inputs), moderation guard mapping (each flag → PASS/REVIEW/FAIL), **schedule-window math** (Asia/Karachi edge cases: slot before 12:00, after 23:00, gap overlap, day rollover — no DST in PKT, asserted), idempotency (double-delivery of same `mid` / same listing → single publish).
- **Fixtures:** `test/fixtures/webhooks/` — text, single image, multi-image burst, sticker, echo (own message), unsupported (video/audio), quick-reply tap, expired-window message. `scripts/replay-webhook.ts` signs each fixture with the app secret and POSTs to the local webhook, asserting state transitions.
- **Mocks:** `lib/meta/__mocks__` and `lib/gemini/__mocks__` for CI (no network, no spend); contract tests assert request shapes match the docs (§1).
- **LIVE_TEST.md:** end-to-end via Instagram **Self Messaging** (account messages itself — no second account): subscribe → send photos → walk the flow → publish in `dry_run` → flip to `review` → approve in /admin → verify live post → delete. Includes the Antigravity browser-agent /admin test with screenshots attached to `walkthrough.md`.
- **Per-phase gate:** no phase is "done" until its tests are green and its `walkthrough.md` (what was built, test evidence, screenshots, known limits) is written.

---

## 14. Phases (build only starts after your approval)

| Phase | Scope | Exit criteria |
|-------|-------|---------------|
| **0 — Plan** | This document + your answers (≤8 questions below) | You reply "approved" (+ answers) |
| **1 — Webhook + storage** | GET verification, signature verify, dedupe, QStash ingest, immediate image download → Storage, Firestore base (conversations, processed_webhooks), `/api/health`, `.env.example` | Unit tests green; replay fixtures (text/image/echo/sticker) pass; walkthrough.md |
| **2 — Conversation engine** | State machine, intent classify, 25s debounce, Gemini extraction (zod), NEEDS_INFO single-question + quick replies w/ typed fallback, language mirror, consent flow (Post/Edit/Cancel), spam/rate limits, `human` flag, 24h-window guard | State-machine + schema tests green; scripted multi-turn fixture replays; walkthrough.md |
| **3 — Moderation + images + caption** | Verdict pipeline (fail closed), dHash duplicates, blocklist, sharp pipeline (1080×1350, blurred-bg contain, strip metadata), cover-slide generator (behind flag), caption writer | Moderation matrix tests; image output assertions (size, colorspace, no EXIF/GPS); walkthrough.md |
| **4 — Publishing + queue** | Slot math, QStash scheduling, container flow + poll/backoff + recreate, idempotency, `content_publishing_limit`, kill switch, PUBLISH_MODEs, seller permalink DM, failure alerts | Schedule-math tests; mocked Meta publish incl. ERROR→recreate; dry_run E2E; walkthrough.md |
| **5 — Admin + alerts** | `/admin` (queue, review actions, publish log, quota gauge, kill switch, token health), Firebase Auth + allowlist + rules, Telegram alerts, token-refresh cron, retention cron | Antigravity browser test of /admin with screenshots; alert delivery verified; walkthrough.md |
| **6 — Hardening + docs** | Full suite green, `README.md`, **`SETUP.md`** (click-by-click: Meta app → Instagram product → API setup with Instagram Login → scopes → app role → Live mode → webhook subscribe `messages` → token exchange; Firebase project/rules/service account; QStash; Vercel env + deploy + crons; Gemini key; BotFather; go-live checklist), `LIVE_TEST.md`, **`AGENTS.md`** (<12,000 chars, non-negotiable rules + commands), **`.agents/workflows/verify.md`** (lint, typecheck, test), pre-commit secret scan | `verify.md` passes clean; docs complete; walkthrough.md |

**Per-phase ritual (your spec):** build → tests → `walkthrough.md`. Planning mode holds until you approve.

---

## 15. `.env.example` (full list — values never committed)

```
IG_API_VERSION=v26.0
IG_APP_ID= · IG_APP_SECRET= · IG_VERIFY_TOKEN= · IG_USER_ID=
IG_TOKEN_ENC_KEY=                              # 32-byte hex, AES-256-GCM
GEMINI_API_KEY= · GEMINI_MODEL=gemini-3.8-flash
FIREBASE_PROJECT_ID= · FIREBASE_CLIENT_EMAIL= · FIREBASE_PRIVATE_KEY=
QSTASH_TOKEN= · QSTASH_CURRENT_SIGNING_KEY= · QSTASH_NEXT_SIGNING_KEY=
ADMIN_EMAILS=you@gmail.com
TELEGRAM_BOT_TOKEN= · TELEGRAM_ADMIN_CHAT_ID=
APP_BASE_URL=https://revault-dm-bot.vercel.app
PUBLISH_MODE=review
MAX_POSTS_PER_DAY=6 · MIN_GAP_MINUTES=90
POSTING_WINDOW_START=12:00 · POSTING_WINDOW_END=23:00 · TimeZone=Asia/Karachi
MAX_LISTINGS_PER_SELLER_PER_DAY=5 · PHOTO_DEBOUNCE_SECONDS=25
RETENTION_DAYS=30 · CAPTION_CTA=dm
COVER_SLIDE_ENABLED=false
```

---

## 16. Risks & mitigations

- **Meta UI relabels often** — SETUP.md describes intent per step and links the official docs; plan re-verifies docs at each phase (your rule 3).
- **Webhook delivery gaps** — dedupe + idempotent workers make retries safe; a daily reconciliation cron lists recent DMs vs processed mids (Phase 6, cheap insurance).
- **Signed-URL race** — 4h TTL + recreate-on-expired (§1.4); Instagram fetch failures surface as container ERROR → automatic retry path.
- **Gemini cost** — ≤5 calls/listing, vision call only on finalize; monthly spend tracked in /admin (token counter per listing in events log).
- **Account safety** — official APIs only, human-paced sends, ~200/hr cap respected, no automation of likes/follows/comments. Ban risk ≈ baseline.

---

## 17. Questions for you (max 8 — reply with answers + "approved")

1. **Brand assets:** please send the ReVault logo (PNG/SVG), brand colours (hex), and either a `/brand/voice.md` draft or 2–3 example captions in your voice. I won't invent them — the cover slide stays off until they arrive.
2. **Meta app:** do you already have a Meta Developer app, or should SETUP.md assume we create one from scratch? (You'll do the Business Login + token generation yourself regardless — it's your account.)
3. **Firebase:** create a **new** Firebase project for the bot (recommended — isolated billing/data/rules), or reuse an existing one? If existing, which?
4. **Gemini:** default `GEMINI_MODEL=gemini-3.8-flash` OK? (Current stable flagship per Google docs re-verified 2026-09-30; 2.5 family retires Oct 16.) You'll paste the API key into Vercel env yourself.
5. **Alerts:** dedicated new Telegram bot for ReVault admin alerts (recommended), or reuse an existing bot? I'll need the bot token + your Telegram chat ID either way.
6. **Defaults OK?** `PUBLISH_MODE=review`, 6 posts/day, 90-min gap, 12:00–23:00 PKT window, 5 listings/seller/day, 2+ photos required before CONFIRM.
7. **Admin allowlist:** which Google email(s) get `/admin` access?
8. **Caption CTA default:** "DM to buy" or link to `revaultx.vercel.app`?

---

## 18. Approval gate

Reply **"approved"** (with answers to §17) and I'll start **Phase 1**. Until then: zero code, only this plan.

*Decisions I made for you (per your "pick one, justify" instructions): Telegram over email for alerts (§3 — you already live on Telegram); QStash + Vercel Cron for async work (§3 — only QStash does second-precision delayed delivery); `gemini-3.5-flash` default (§1.7). Everything else follows your spec verbatim.*
