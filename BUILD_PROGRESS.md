# BUILD_PROGRESS.md — checkpoint log (build coordinator)

Autonomous build while Asim sleeps (~8h window from 2026-09-30 22:02 PKT).
Hourly self-improvement passes are appended here with timestamps.

---

## 2026-09-30 22:05 PKT — Build start
- Read implementation_plan.md in full. User approved FULL autonomous build (plan + code).
- Decisions locked: new Firebase project (assumed), dedicated Telegram bot (assumed),
  GEMINI_MODEL=gemini-3.5-flash, PUBLISH_MODE=review, COVER_SLIDE_ENABLED=false,
  IG_API_VERSION=v26.0.
- Scaffolded: package.json (next 16.3.8, react 19, @google/genai 2.24, @upstash/qstash 2.12,
  firebase-admin 14.5.0, sharp 0.35.5, zod 4.6.5, vitest 5.0.3, satori 0.33.5),
  tsconfig strict, vitest config, .gitignore, .env.example (full var list),
  shared contracts lib/types.ts + lib/env.ts + lib/log.ts, brand/README.md placeholder.
- npm install kicked off in background.
- Fanning out to 5 phase subagents (1: webhook/ingest/db/storage/qstash/health;
  2: conversation engine + gemini; 3: moderation + images + caption;
  4: publishing engine + schedule; 5: admin UI + alerts + crons + rules).
- Coordinator owns: integration, Phase 6 docs, final full test run, BUILD_REPORT.md.

## 2026-09-30 22:12 PKT — Fanned out to 5 phase agents (parallel)
- Phase 1 (webhook/verify/db/storage/qstash/health/fixtures/replay): delegated.
- Phase 2 (conversation engine + Gemini client + prompts + message/finalize workers): delegated.
- Phase 3 (moderation + sharp image pipeline + caption): delegated.
- Phase 4 (Meta API client + tokens + schedule math + publish/poll workers): delegated.
- Phase 5 (admin UI + admin API + Telegram + crons + rules + grant-admin): delegated.
- Cross-phase contracts fixed in scaffold: lib/types.ts, lib/meta.ts, lib/gemini.ts,
  lib/telegram.ts (+ moderation.ts/caption.ts signatures specified in briefs).
- npm install running in background (proc_3bfd05fc9be3).
- Coordinator next: hourly doc re-verification passes; integration + Phase 6 docs
  (README, SETUP.md, LIVE_TEST.md, AGENTS.md, .agents/workflows/verify.md,
  pre-commit hook) + full test run + BUILD_REPORT.md once phases land.

## 2026-09-30 22:15 PKT — Phase 3 DONE (moderation + images + caption)
- 36/36 Phase 3 tests green; full suite 133/133 green at that point.
- tsc clean for Phase 3 files; remaining errors in other phases' in-progress files.
- walkthrough-phase3.md written.
- Cross-phase notes for integration: Phase 1's lib/db.ts provides
  findDuplicatePhashEntry() (adopted); Phase 3 exports recordPhash() expectation —
  Phase 2 must call recordPhash(phash, listingId) after intake; types.ts drifted
  (publish.container_status, locked_until, chat_text) — verify final shapes at
  integration. Judgment calls: offensive_text→FAIL, all-photos-not-clothing→REVIEW,
  hamming ≤6 (empirically pinned). buildCoverSlide throws BrandAssetsMissing;
  brandAssetsAvailable() currently false (no /brand/colours.json — correct).
- 4 agents still running (phases 1, 2, 4, 5).

## 2026-09-30 22:20 PKT — Phase 1 DONE (webhook + storage + qstash)
- 61/61 new tests green (webhook 24, qstash 11, ingest 10, env 9, log 7); full suite 176/176 green.
- tsc clean for Phase 1 files. Live smoke on next dev: GET handshake 200/403, bad sig 401, health 200 degraded.
- walkthrough-phase1.md written. Deliberate deviation: enqueue BEFORE claiming mid
  (claim-first loses messages if enqueue fails after claim; dedup id keeps it safe).
- New env: FIREBASE_STORAGE_BUCKET (optional) — add to .env.example in Phase 6.
- TODO Phase 6: Firestore TTL policy on processed_webhooks.expire_at (SETUP.md).
- Integration flags: saveListing is shallow-Partial — Phase 4 poll-container passes
  nested partials (needs DeepPartial or full-object rebuild); idempotency.test.ts
  imports MetaClient from wrong module; types.ts now has chat_text,
  publish.container_status/locked_until, user_msg_total, last_processed_mid.
- 3 agents still running (phases 2, 4, 5).

## 2026-09-30 22:21 PKT — Phase 5 DONE (admin UI + alerts + crons + rules)
- lib/telegram.ts implemented (HTML-escaped, 4096-char cap, safe no-op unconfigured).
- app/admin dashboard: Google sign-in, queue cards w/ photo previews + caption edit,
  Approve/Reject/Ban/Retry, publish log, quota gauge, kill-switch toggle, token health.
- app/api/admin catch-all (13 routes), 3 cron routes (CRON_SECRET auth), grant-admin
  script, firestore.rules + storage.rules (deny-all except admin claim), vercel.json.
- 16 new tests green; tsc zero errors in Phase 5 files. firebase@12.19.0 installed.
- .env.example extended: CRON_SECRET, NEXT_PUBLIC_FIREBASE_*, FIREBASE_STORAGE_BUCKET.
- INTEGRATION DEBT (coordinator, Phase 6): two Admin SDK init points
  (lib/firebase-admin.ts vs lib/db.ts) — consolidate on one; duplicated
  appendListingEvent/getAdminSettings — dedupe; lib/publish-queue.ts wraps
  enqueueWorker (fine); lib/ig-token.ts holds token crypto, Phase 4 tokens.ts
  delegates (verify at integration). /admin browser test deferred to Phase 6.
- 2 agents still running (phases 2 and 4).

## 2026-09-30 22:22 PKT — Phase 4 DONE (publishing engine + Meta client)
- lib/meta.ts: full client (send/containers/publish/permalink/quota); quota_total
  from nested config (never hardcoded); MetaApiError.isWindowError().
- lib/schedule.ts: PKT slot math; lib/tokens.ts thin adapter over ig-token.ts.
- publish + poll-container workers: idempotency-first, claim lease (10-min),
  kill-switch per step, review gate (bug caught by tests: preStatus fix),
  ERROR→recreate ≤3, backoff min(30·2^a,300), media_publish at-most-once.
- 15 test files, 176/176 green; tsc clean for Phase 4 files.
- walkthrough-phase4.md written. Known limitation: media_publish has no
  idempotency key — never auto-retried after ambiguous throw (documented).
- Integration flags: reconcile route has unterminated template literal (fix in
  Phase 6); DeepPartial added to types.ts; dedupe firebase init paths pending.
- 1 agent still running (Phase 2 conversation engine).

## 2026-09-30 22:29 PKT — Phase 2 DONE (conversation engine + Gemini). ALL 5 PHASES COMPLETE.
- lib/gemini.ts (@google/genai, structured output via config.responseJsonSchema,
  refuses gemini-2.5*), lib/conversation.ts (state machine, sendSafe 24h guard,
  no HUMAN_AGENT), lib/finalize.ts (fail-closed), prompts in ur/roman/en.
- 83 new tests; full suite 259/259 green; tsc clean.
- walkthrough-phase2.md written. Integration notes: ingest→message handoff via
  saveInboundMessage/getInboundMessage; env.ts requireMetaEnv type fixed for zod v4.
- Coordinator now: integration (dedupe firebase init, fix reconcile template
  literal, verify recordPhash wiring, DeepPartial saveListing), Phase 6 docs,
  full verification, BUILD_REPORT.md.

## 2026-09-30 22:45 PKT — Doc re-verification #1: Gemini models (ai.google.dev)
- Official models page (updated 2026-09-24): gemini-3.8-flash = current stable
  flagship ("most intelligent Flash model"); gemini-3.5-flash still Stable
  ("legacy Flash model"). gemini-2.5 family NOT shut down yet but our refusal
  guard stands (retires 2026-10-16 per plan).
- DECISION: GEMINI_MODEL default → gemini-3.8-flash (was 3.5-flash). Rationale:
  vision extraction + moderation are the quality-critical calls; per-listing
  volume is tiny so cost delta is negligible; plan explicitly said re-verify
  at build time. Revertible via env (gemini-3.5-flash stays valid).
- Updated: lib/env.ts, .env.example, test/setup.ts, lib/env.test.ts,
  lib/gemini.ts comments. Tests green, tsc clean.

## 2026-09-30 22:50 PKT — Doc re-verification #2: Meta Graph API version
- Official changelog (crawled <1h ago): latest = v26.0 (2026-07-29). Our
  IG_API_VERSION=v26.0 default correct. No change.
