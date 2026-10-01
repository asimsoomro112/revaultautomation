# BUILD_REPORT.md — ReVault DM-to-Post Bot

**Built:** 2026-09-30, ~22:02–23:00 PKT (unattended, while Asim slept — full
autonomous build authorized 22:01 PKT).
**Repo:** `~/workspace/revault-dm-bot/` (git initialized, all work committed).
**Plan:** `implementation_plan.md` (approved; docs findings verified 2026-09-30).

## What was built

| Phase | Contents | Tests | Walkthrough |
|---|---|---|---|
| 1 — Webhook/ingest | `lib/webhook.ts` (HMAC-SHA256 raw-body, timing-safe; GET challenge; zod payload parse), `lib/db.ts` (Firestore helpers, `claimWebhookMid` transaction, blocklist, phash index, daily counters), `lib/storage.ts` (20s/15MB guarded download → private Storage; 4h signed URLs), `lib/qstash.ts` (enqueue + signature verify), `lib/ingest.ts` (pure `processIngest`; images downloaded NOW; zero messages sent), routes: `webhooks/instagram`, `workers/ingest`, `health`; 7 fixtures + `scripts/replay-webhook.ts` | 61 new | `walkthrough-phase1.md` |
| 2 — Conversation + Gemini | `lib/gemini.ts` (`@google/genai`, `classifyIntent`/`extractListing`/`writeCaption`/`chatReply`, structured output, refuses `gemini-2.5*`), `lib/prompts.ts` (ur/roman/en copy, quick replies ≤13/≤20 chars + typed fallbacks), `lib/conversation.ts` (state machine IDLE→COLLECTING→NEEDS_INFO→CONFIRM→SUBMITTED; `sendSafe` 24h-window guard; no HUMAN_AGENT), `lib/finalize.ts` (fail-closed), `lib/server-deps.ts`, routes `workers/message` + `workers/finalize-photos` | 83 new | `walkthrough-phase2.md` |
| 3 — Moderation/images/caption | `lib/moderation.ts` (fail-closed: blocklist→FAIL, dup→REVIEW, nudity/minors/offensive-text→FAIL, faces/contact/counterfeit/stock→REVIEW, any exception→REVIEW; Hamming ≤6 empirically pinned), `lib/images.ts` (EXIF rotate → blurred self-fill + contain-fit → 1080×1350 sRGB JPEG q85, metadata stripped; dHash), `lib/caption.ts` (CTA line, 3–5 hashtags, phone/email stripped, ≤2200 chars), `lib/ig-token.ts` | 36 new | `walkthrough-phase3.md` |
| 4 — Publishing engine | `lib/meta.ts` (sendMessage, image/carousel containers, media_publish, permalink, live `content_publishing_limit` quota), `lib/schedule.ts` (PKT slot math, 12:00–23:00 Asia/Karachi), `lib/tokens.ts` (AES-256-GCM adapter), `lib/workers/publish.ts` + `poll-container.ts` (idempotency-first, 10-min claim lease, kill-switch per step, review gate, ERROR→recreate ≤3, backoff 30s→300s, `media_publish` at-most-once), routes | 15 files | `walkthrough-phase4.md` |
| 5 — Admin/alerts/crons | `app/admin/` dashboard (Google sign-in, queue cards, approve/reject/ban/retry, publish log, quota gauge, kill switch, token health), `app/api/admin/[[...path]]/route.ts` (13 routes, admin-claim auth), `lib/telegram.ts` (HTML-escaped, 4096-char cap, never throws), crons: `token-refresh`/`retention`/`reconcile`, `scripts/grant-admin.ts`, `firestore.rules` + ~~`storage.rules`~~ (deny-all except admin claim; `storage.rules` removed 2026-10-01 with the Cloudinary swap), `vercel.json` | 16 new | `walkthrough-phase5.md` |
| 6 — Integration + docs (coordinator) | Single Firebase init (`lib/db.ts`; `firebase-admin.ts` → shim), duplicate `appendListingEvent`/`getAdminSettings` deduplicated, **duplicate-index write path wired** (`finalize.ts` computes dHash per photo + `recordPhash`; was read-only before), `README.md`, `SETUP.md`, `LIVE_TEST.md`, `AGENTS.md`, `.agents/workflows/verify.md`, pre-commit secret hook, this report | 3 new | `BUILD_PROGRESS.md` |

## Test evidence (final, 2026-09-30 ~23:00 PKT)

- `npx vitest run` → **262/262 passed** (20 files), fully mocked — no network, no spend.
- `npx tsc --noEmit` → **zero errors** (strict, `exactOptionalPropertyTypes`).
- Live smoke on `next dev` (Phase 1): webhook GET 200/403, bad signature 401, health 200 degraded.
- Pre-commit secret hook installed (`.githooks/`, `core.hooksPath` set) and passing.

## Post-build change: photo storage Firebase → Cloudinary (2026-10-01)

On Asim's instruction ("firebase hata ke cloudinary lagao"), photo storage
moved from Firebase Storage to Cloudinary. **Firestore (database) and Firebase
Auth (admin Google login) stay** — free tier, untouched. Only photos moved.

- `lib/storage.ts` rewritten as the single Cloudinary module: signed uploads
  into `revault/listings/` as `type: 'private'` assets (deterministic
  `public_id` = logical path without extension), delivery via
  `private_download_url` with `expires_at` (~4h, never persisted), bulk
  retention via `api.delete_resources_by_prefix`.
- Firestore `storage_path` values keep the existing logical format
  (`raw/{listingId}/{photoId}.jpg`, `slides/…`); the mapping lives inside
  `lib/storage.ts`, so ingest/queue/worker code is unchanged.
- Removed: `storage.rules`, `FIREBASE_STORAGE_BUCKET`, the Storage half of
  `lib/db.ts` (`storage()`, `downloadBytes`, `uploadBytes`, `signedReadUrl`)
  and `adminStorage()` from `lib/firebase-admin.ts`; retention cron now calls
  `deletePrefix('raw/{listingId}/')`.
- New env: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`,
  `CLOUDINARY_API_SECRET` (server-only).
- **Test evidence:** new `lib/storage.test.ts` (15 tests, Cloudinary SDK
  mocked — upload contract, download guards, `private_download_url` ~4h
  expiry, `deletePrefix`); full suite **277/277 green**, `tsc --noEmit`
  **clean** (verified 2026-10-01).
- Full walkthrough: `walkthrough-storage-cloudinary.md`.

## Deliberate deviations from the plan (documented)

1. **Webhook: enqueue BEFORE claiming `mid`.** Claim-first loses messages if the
   enqueue fails after the claim; dedup id + transaction keep it safe.
2. **`GEMINI_MODEL` default → `gemini-3.8-flash`** (was `gemini-3.5-flash`).
   Re-verified 2026-09-30 at ai.google.dev/gemini-api/docs/models: 3.8 Flash is
   the current stable flagship; 3.5 Flash explicitly "legacy". Vision extraction
   + moderation are the quality-critical calls and per-listing volume is tiny,
   so the cost delta is negligible. Env-revertible (`gemini-3.5-flash`).
3. ~~**New optional env `FIREBASE_STORAGE_BUCKET`** (Admin SDK needs an explicit
   bucket; defaults to `<project>.firebasestorage.app`).~~
   **Superseded 2026-10-01** by the Cloudinary storage swap (photos no longer
   touch Firebase Storage; `CLOUDINARY_CLOUD_NAME`/`_API_KEY`/`_API_SECRET`
   replace it).
4. **`lib/firebase-admin.ts` is a shim over `lib/db.ts`** (single init point;
   db.ts's init sets `storageBucket`). Same exports, same callers.
5. **`lib/publish-queue.ts`** wraps `enqueueWorker` for admin approve/retry —
   one enqueue path, no duplication.

## Known limitations (not bugs — read before go-live)

- `media_publish` has no idempotency key: a throw after server-side success is
  indistinguishable from failure → listing goes FAILED with an admin alert
  ("check the IG profile before manual retry"). Never auto-retried by design.
- Reconcile cron: DM-vs-webhook diff is skipped (needs extra Conversations API
  scopes); stuck-PUBLISHING >2h → FAILED + alert works.
- `/admin` browser test (screenshots) needs a real logged-in browser session —
  it's a manual step in `LIVE_TEST.md` §6 (subagents can't do live-browser work).
- Cover slide: `COVER_SLIDE_ENABLED=false` and no `/brand` assets — Asim hasn't
  sent logo/colours/voice yet. `buildCoverSlide` throws `BrandAssetsMissing`
  rather than inventing anything.
- Telegram alerts are a safe no-op until `TELEGRAM_BOT_TOKEN` +
  `TELEGRAM_ADMIN_CHAT_ID` are set.

## Assumptions made (flag if wrong)

New Firebase project · dedicated new Telegram bot · `PUBLISH_MODE=review` ·
`GEMINI_MODEL=gemini-3.8-flash` · region `asia-south1` suggested ·
`@therevaultofficial` is a professional (Business/Creator) account.

---

## ☀️ MORNING CHECKLIST FOR ASIM

Everything below needs **you** (logins only you have). The code is done and
tested — no coding needed from you, just keys and clicks. Full click-by-click
in `SETUP.md`.

### Keys to paste into Vercel env (one screen: vercel.com → project → Settings → Environment Variables)

**Meta** (developers.facebook.com → your app → Instagram product):
- [ ] `IG_APP_ID`, `IG_APP_SECRET`
- [ ] `IG_VERIFY_TOKEN` — make one up: `openssl rand -hex 16` (paste the SAME string in the Meta webhook subscribe dialog)
- [ ] `IG_USER_ID` — numeric id of @therevaultofficial (shown in the Instagram product after Instagram Login)
- [ ] `IG_API_VERSION=v26.0` (already the default; set explicitly to be safe)

**Token crypto + cron:**
- [ ] `IG_TOKEN_ENC_KEY` — `openssl rand -hex 32`
- [ ] `CRON_SECRET` — `openssl rand -hex 32`

**Gemini** (aistudio.google.com/apikey):
- [ ] `GEMINI_API_KEY=<redacted>`

**Firebase** (console.firebase.google.com → new project → service account JSON):
- [ ] `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (one line, `\n` escapes kept)
- [ ] `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID` (web app config; also enable Google sign-in)
- [ ] Deploy `firestore.rules` from the repo, and set **TTL policies** on `processed_webhooks.expire_at` and `inbound_messages.expire_at` (no Firebase Storage setup — photos moved to Cloudinary, see below)

**Cloudinary** (cloudinary.com → free signup, no credit card → Dashboard):
- [ ] `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
- [ ] Free tier covers us easily: 25 pooled credits/month; even 1000 listings × 9 photos × ~200KB ≈ **1.8GB ≈ ~2 credits**

**QStash** (console.upstash.com):
- [ ] `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`

**Telegram** (@BotFather → /newbot; then message the bot and read getUpdates):
- [ ] `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID`

**App:**
- [ ] `APP_BASE_URL=https://<your-vercel-domain>`
- [ ] Behaviour defaults are already safe (`PUBLISH_MODE=review`, 6 posts/day max, 12:00–23:00 PKT window) — leave them.

### Manual steps (nobody else can do these)

1. [ ] Meta app: Instagram product → **API setup with Instagram Login** → scopes
      `instagram_business_basic` + `instagram_business_manage_messages` + `instagram_business_content_publish` → add yourself as app role → generate the short-lived token
2. [ ] Meta webhooks: subscribe `messages` → callback `https://<domain>/api/webhooks/instagram` + your verify token
3. [ ] Deploy on Vercel with all env vars above (crons come from `vercel.json`)
4. [ ] Open `https://<domain>/admin` → sign in with Google (expect "Access denied") → run `npm run grant-admin -- your@gmail.com` → sign in again
5. [ ] Health check: `GET https://<domain>/api/health` → `{ ok: true, … }`
6. [ ] Walk `LIVE_TEST.md` (DM the page from itself — Self Messaging): dry_run first, then review → approve → verify the live post → delete it
7. [ ] Flip the Meta app to **Live mode**
8. [ ] Send me your **logo + brand colours + caption voice** whenever ready — then I'll enable the cover slide (`COVER_SLIDE_ENABLED=true`)

**Emergency stop:** the big red kill switch in `/admin` halts every worker instantly.
