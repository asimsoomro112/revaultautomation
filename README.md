# ReVault DM-to-Post Bot

Instagram DM → moderated, captioned, scheduled Instagram post — fully automated for
Asim's preloved-clothes page **[@therevaultofficial](https://www.instagram.com/therevaultofficial)**.

A seller DMs photos + details to the page. The bot chats back (Roman Urdu / Urdu / English),
collects missing info, runs a fail-closed moderation pipeline, builds a caption, and —
after admin approval (default) — publishes a 4:5 carousel post on a PKT schedule.
Everything is idempotent, kill-switched, and logged.

**Stack:** Next.js 16 (App Router, Vercel) · Instagram API with Instagram Login
(`graph.instagram.com`, API v26.0) · Gemini (`gemini-3.8-flash` default) ·
Firebase (Firestore + Storage) · Upstash QStash (all async/delayed work) ·
Telegram (admin alerts) · sharp (1080×1350 slide pipeline) · satori (cover slide)

## How it works

```
Seller DM ──▶ Meta ──▶ POST /api/webhooks/instagram (verify → dedupe → enqueue → 200 fast)
                                    │
                          QStash ──▶ /api/workers/ingest
                                     │ download image bytes NOW → private Storage
                                     │ DRAFT listing, COLLECTING state, re-arm 25s debounce
                          QStash ──▶ /api/workers/finalize-photos
                                     │ ONE Gemini vision call (extraction + moderation)
                                     │ applyModeration → FAIL / REVIEW / PASS
                          QStash ──▶ /api/workers/message
                                     │ state machine: IDLE → COLLECTING → NEEDS_INFO
                                     │   → CONFIRM (consent quick replies) → SUBMITTED
                          QStash ──▶ /api/workers/publish (at PKT slot, notBefore)
                                     │ kill-switch → quota → 1080×1350 slides →
                                     │ containers → poll FINISHED → media_publish
                                     │ → permalink → DM seller 🎉
/admin ── review queue · approve/reject/ban/retry · publish log · quota gauge ·
         kill switch · token health (Firebase Google sign-in, admin claim only)
```

All waiting (photo debounce, slot scheduling, container polling) is expressed as
**delayed QStash messages** — Vercel serverless has no long-running processes.
Every worker is idempotent: the listing id is the idempotency key, and
`media_publish` is called at most once per listing.

## Quick start

```bash
npm install
npm test            # 262 tests, no network, no spend (mocks)
npm run dev         # next dev
```

Copy `.env.example` → `.env.local` and fill values (see **SETUP.md** for where each
value comes from). Nothing works without real credentials — the suite is fully
mocked so the build is verifiable without them.

## Project layout

```
app/api/webhooks/instagram/   Meta webhook (GET handshake, POST HMAC verify)
app/api/workers/{ingest,message,finalize-photos,publish,poll-container}/
app/api/admin/[[...path]]/    13 admin API routes (admin claim required)
app/api/cron/{token-refresh,retention,reconcile}/  Vercel Cron jobs
app/admin/                    Admin dashboard (dark UI, no brand assets invented)
lib/                          Domain libs: webhook, ingest, conversation, finalize,
                              moderation, images, caption, gemini, meta, tokens,
                              schedule, db, storage, qstash, telegram, prompts
scripts/                      replay-webhook.ts, grant-admin.ts
test/fixtures/webhooks/       7 webhook fixtures for replay + tests
brand/                        Brand assets (empty until Asim provides logo/colours)
```

## Key contracts

- **Moderation is fail-closed.** Blocklist → FAIL · dup photo → REVIEW ·
  nudity/minors/offensive-text → FAIL · faces/contact-info/counterfeit/stock
  suspicion → REVIEW · **any exception → REVIEW** (never PASS).
- **Every publish step re-checks the kill switch** (`admin_settings.global_kill_switch`).
- **No message is ever sent outside the 24h window.** No `HUMAN_AGENT` tag, ever.
- **Phone/email are stripped from captions** (prices survive). Photos are
  EXIF-rotated, metadata-stripped, 1080×1350 JPEG.
- **Secrets only via env.** PII redacted at the log boundary.

## Docs

| Doc | Contents |
|---|---|
| `SETUP.md` | Click-by-click setup: Meta app → Instagram Login → Firebase → QStash → Vercel → Gemini → Telegram → go-live checklist |
| `LIVE_TEST.md` | End-to-end test via Instagram Self Messaging (no second account needed) |
| `AGENTS.md` | Contributor rules, non-negotiables, commands |
| `.agents/workflows/verify.md` | Lint → typecheck → test workflow |
| `walkthrough-phase{1..5}.md` | Per-phase build notes, test evidence, known limits |
| `BUILD_REPORT.md` | Final build report + morning checklist for Asim |
| `implementation_plan.md` | The approved plan this build implements |

## Verification

```bash
npm test            # vitest — 262 tests green
npx tsc --noEmit    # strict TypeScript — clean
```

`GET /api/health` → `{ ok, firestore, qstash, gemini, ig_token_expires_in_days }`
(no secrets, never throws without env).

## Behaviour defaults (env-overridable)

`PUBLISH_MODE=review` · `MAX_POSTS_PER_DAY=6` · `MIN_GAP_MINUTES=90` ·
window `12:00–23:00 Asia/Karachi` · `PHOTO_DEBOUNCE_SECONDS=25` ·
`COVER_SLIDE_ENABLED=false` (until `/brand` assets arrive)
