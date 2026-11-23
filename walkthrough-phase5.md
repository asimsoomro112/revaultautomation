# Phase 5 walkthrough — Admin UI + alerts + crons + security rules

**Date:** 2026-09-30 · **Scope:** plan §§11, 12, 13 (Phase 5 rows) · **Status:** built, tests green, walkthrough written.

## What was built

### Alerts — `lib/telegram.ts` (implemented, was a Phase-5 stub)
- `notifyAdmin(text, opts?)`: `POST https://api.telegram.org/bot<TOKEN>/sendMessage`
  with `{ chat_id, text, parse_mode: "HTML", disable_web_page_preview: true }`.
- Whole body HTML-escaped (`&` `<` `>`), truncated to 4096 chars with `…` marker.
- **Never throws** — network/API failures are logged, never fatal to the calling worker.
- Safe no-op (`log.warn`) when `TELEGRAM_BOT_TOKEN` / `TELEGRAM_ADMIN_CHAT_ID` unset.
- Exports `escapeHtml`, `truncateForTelegram`, `TELEGRAM_MAX_TEXT` for reuse/tests.

### Server foundation (new; Phase 1's `lib/db.ts` had not landed when Phase 5 started)
- `lib/firebase-admin.ts` — single Admin SDK init point (`getAdminApp`, `adminDb`,
  `adminAuth`, `adminStorage`) + `appendListingEvent(listingId, type, {by, detail})`
  + `getAdminSettings()` (merged over safe defaults) / `updateAdminSettings()`.
- `lib/admin-auth.ts` — pure, unit-testable authorizer: 401 on missing/invalid
  Bearer token; grant on custom claim `admin===true`, else on `ADMIN_EMAILS`
  allowlist (bootstrap path, case-insensitive); 403 otherwise. Logs which grant path fired.
- `lib/cron-auth.ts` — timing-safe `Authorization: Bearer <CRON_SECRET>` check, fail-closed.
- `lib/ig-token.ts` — IG long-lived token crypto (AES-256-GCM, `IG_TOKEN_ENC_KEY` 32-byte hex)
  + `refreshLongLivedToken()` (`GET {IG_API_BASE}/refresh_access_token?grant_type=ig_refresh_token&access_token=…`,
  ≥24h-age guard per Meta rule) + `storeToken()` + `isRefreshDue()` (7-day window)
  + `daysUntilExpiry()` + `markTokenDegraded()` + `getDecryptedToken()` (the signature
  `lib/meta.ts`'s contract expects — for Phase 4's Meta client to use).
- `lib/publish-queue.ts` — best-effort wrapper around **Phase 1's** `enqueueWorker`
  (single enqueue path, no duplication): `{ kind: "publish", listing_id }` →
  `/api/workers/publish`; returns `false` instead of throwing when QStash is unconfigured.

### Admin API — `app/api/admin/[[...path]]/route.ts` (catch-all, Node runtime)
All routes require admin auth (401/403 otherwise); every mutation appends to
`listings/{id}/events`:
| Method & path | Action |
|---|---|
| `GET /queue` | actionable listings (NEEDS_REVIEW/QUEUED/SUBMITTED/APPROVED/PUBLISHING/FAILED), newest first, 50; fresh 4h signed photo URLs |
| `GET /listings/:id` | full doc + signed photo URLs + last 25 events |
| `POST /listings/:id/approve` | → APPROVED (+review record), enqueue publish worker |
| `POST /listings/:id/reject {reason}` | → REJECTED, polite seller DM (best-effort via Meta client) |
| `POST /listings/:id/caption {caption}` | caption update (zod ≤2200 chars) |
| `POST /listings/:id/retry` | FAILED → QUEUED, enqueue publish worker |
| `POST /sellers/:igsid/ban {reason}` | blocklist doc + `conversations/{igsid}.blocked=true` + Telegram alert |
| `GET /publish-log` | recent PUBLISHED: permalink, published_at, seller (truncated), slot latency, attempts |
| `GET /quota` | `{ today_count (PKT day), max, meta: {quota_usage, quota_total} }` — Meta read best-effort |
| `GET /settings` | kill_switch, publish_mode, window, retention_days (drives the UI toggle) |
| `POST /kill-switch {on}` | flips `global_kill_switch` + Telegram alert |
| `GET /token-health` | expires_at, days_left, health badge, ig_user_id |
| `POST /token-refresh` | manual refresh → store; on failure 502 + Telegram alert + health=degraded |

### Admin UI — `app/admin/` (React 19, dark neutral theme, text logo "ReVault Admin")
- `app/layout.tsx` (root layout — was missing), `firebase-client.ts` (client SDK init
  from `NEXT_PUBLIC_FIREBASE_*`), `components/api.ts` (Bearer-token fetch helper,
  `ApiError`, response types), `components/SignInScreen.tsx` (Google popup sign-in),
  `components/QueueSection.tsx` (listing cards: photo strip, extracted-data table,
  moderation verdict + reasons, editable caption, Approve / Save caption / Reject
  (reason prompt) / Ban seller (confirm + reason) / Retry failed),
  `components/PublishLog.tsx` (permalink links, latency), `components/QuotaGauge.tsx`
  (today/max bar + Meta quota), `components/KillSwitch.tsx` (big red toggle +
  `confirm()`), `components/TokenHealth.tsx` (expiry, days left, badge, Refresh now).
- `page.tsx`: auth gate — sign-in screen when logged out; **"Access denied"** screen
  on 401/403 (with sign-out); dashboard otherwise. No brand assets invented.

### Crons (GET only, `CRON_SECRET` Bearer auth, idempotent)
- `app/api/cron/token-refresh/route.ts` — refresh when `expires_at − now < 7d`;
  failure → Telegram alert + `token_health: "degraded"`.
- `app/api/cron/retention/route.ts` — deletes `raw/{listingId}/` originals for
  PUBLISHED/REJECTED listings older than `RETENTION_DAYS`; `slides/` kept.
  Single-field queries only (no composite index needed).
- `app/api/cron/reconcile/route.ts` — listings stuck in PUBLISHING > 2h with no
  worker activity → FAILED + Telegram alert. **Documented limitation:** the
  DM-vs-webhook diff is skipped — reading recent conversations needs extra Meta
  scopes we don't request (per task brief).

### Ops files
- `scripts/grant-admin.ts` (`npm run grant-admin -- a@b.c …`): `getUserByEmail` →
  `setCustomUserClaims({admin:true})`; prints per-email OK/FAIL; notes the
  sign-out/in (≤1h) propagation rule.
- `firestore.rules` / `storage.rules`: `rules_version='2'`, deny-all except
  `request.auth != null && request.auth.token.admin == true` (all real access is
  via Admin SDK anyway).
- `vercel.json`: three crons — `0 3 * * *` (token-refresh) = **08:00 PKT**,
  `30 3 * * *` (retention) = **08:30 PKT**, `0 */6 * * *` (reconcile) =
  **05:00/11:00/17:00/23:00 PKT**. Schedules are UTC per Vercel docs.
- `.env.example`: added `CRON_SECRET=` (generate: `openssl rand -hex 32`),
  `NEXT_PUBLIC_FIREBASE_API_KEY/_AUTH_DOMAIN/_PROJECT_ID`, `FIREBASE_STORAGE_BUCKET`.
  `lib/env.ts` schema extended accordingly.
- `package.json`: added `firebase@^12.6.0` (resolved 12.19.0) for the client SDK.

## Docs re-verification (before coding — docs win)
| Area | Verified | Deviation from plan |
|---|---|---|
| Telegram `sendMessage` | POST `https://api.telegram.org/bot<token>/sendMessage`, JSON `{chat_id, text, parse_mode, disable_web_page_preview}`, 4096-char limit, HTML escape `&<>"` | none — implemented exactly |
| Vercel Cron | `vercel.json` `{crons:[{path, schedule}]}`; schedules UTC; Vercel sends `Authorization: Bearer $CRON_SECRET` automatically when set; GET; best-effort/idempotent; Hobby throttles to daily | none — plus documented PKT equivalents |
| Firebase Auth web (modular) | `initializeApp` → `getAuth` → `GoogleAuthProvider` + `signInWithPopup` → `onAuthStateChanged` → `user.getIdToken()` | none |
| Admin SDK | `getAuth().verifyIdToken(idToken)` → claims; `getAuth().getUserByEmail()` + `setCustomUserClaims(uid, {admin:true})`; claims reach the ID token on next issuance (≤1h / force via `getIdToken(true)`) | none — grant-admin prints the propagation note |
| Firestore rules + custom claims | `request.auth.token.admin == true` gate | none |
| IG token refresh | `GET graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=…`, only when token ≥24h old | none — 24h guard implemented, returns clean error |

## Test evidence
- `npm test`: **my 3 files green — 16/16** (`lib/telegram.test.ts` 8: URL shape, JSON body,
  HTML escaping, 4096 truncation, no-op when unconfigured, API-rejection + network-failure
  never throw; `lib/admin-auth.test.ts` 6: 401 no header, 401 bad token, claim grant,
  allowlist grant, case-insensitive allowlist, 403 stranger; `test/rules.test.ts` 2:
  both rules files exist + contain the admin-claim gate, no open `allow … if true`).
- `npx tsc --noEmit`: **zero errors in any Phase 5 file** (`lib/telegram.ts`,
  `lib/firebase-admin.ts`, `lib/admin-auth.ts`, `lib/cron-auth.ts`, `lib/ig-token.ts`,
  `lib/publish-queue.ts`, `app/api/admin/[[...path]]/route.ts`, all three cron routes,
  all `app/admin/*` files, `scripts/grant-admin.ts`, `lib/env.ts`).

## Known issues NOT mine (for the coordinator)
- `npx tsc --noEmit` reports **8 errors in sibling-phase files** (landed/fixed
  concurrently — count dropped from 16 to 8 during this build as their owners
  fixed theirs): `lib/workers/poll-container.ts` ×4, `lib/workers/idempotency.test.ts` ×1,
  `lib/meta.ts` ×1, `lib/tokens.ts` ×1 (all Phase 4 — tokens.ts:69 is
  `encodeURIComponent(env.IG_APP_SECRET)` on `string|undefined`), `lib/log.ts` ×1
  (scaffold). **Zero in Phase 5 files**; I did not touch sibling files.
- `npm test`: 3 failures in **Phase 4's** `lib/workers/idempotency.test.ts`
  (review-mode parking + quota-reschedule expectations vs `handlePublish` behavior).
  Appeared only after Phase 4's files landed mid-build; unrelated to Phase 5.

## Integration notes for the coordinator
1. **Phase 4 adapted to Phase 5's token module**: `lib/tokens.ts` re-exports my
   `encryptToken`/`decryptToken` and delegates refresh/store to `lib/ig-token.ts`.
   Single implementation — no duplication. Phase 4's Meta client should read the
   token via `getDecryptedToken()` from `lib/ig-token.ts`.
2. **Two Admin SDK init points exist**: my `lib/firebase-admin.ts` and Phase 1's
   `lib/db.ts` (both guard via `getApps()`). Recommend keeping one init
   (`lib/firebase-admin.ts` is type-clean) and pointing `db.ts` at it. Same for
   `appendListingEvent` / `getAdminSettings` (both modules define them; mine are
   used by all Phase 5 routes/crons).
3. **Enqueue path unified**: my `lib/publish-queue.ts` wraps Phase 1's
   `enqueueWorker("publish", …)` — one path, best-effort boolean for the UI.
4. **Sibling type change noticed**: `lib/types.ts` gained `chat_text` (ListingDoc)
   and `user_msg_total`/`last_processed_mid` (ConversationDoc) from another phase —
   my code only reads docs via casts, unaffected.
5. npm install hiccup: the first `npm i -S firebase` died on `ENOTEMPTY
   node_modules/next/dist/api` (stale partial install); removed `node_modules/next`
   + added `firebase` to package.json manually, re-ran `npm install` — clean.
6. **Browser-based /admin test (sign-in → queue actions → screenshots) is deferred
   to Phase 6** per the task brief — the UI is built untested against a live backend
   (no Firebase project/keys exist yet).

## Files delivered
`lib/telegram.ts`, `lib/telegram.test.ts`, `lib/firebase-admin.ts`, `lib/admin-auth.ts`,
`lib/admin-auth.test.ts`, `lib/cron-auth.ts`, `lib/ig-token.ts`, `lib/publish-queue.ts`,
`app/layout.tsx`, `app/admin/page.tsx`, `app/admin/firebase-client.ts`,
`app/admin/styles.module.css`, `app/admin/components/api.ts`, `app/admin/components/{SignInScreen,QueueSection,PublishLog,QuotaGauge,KillSwitch,TokenHealth}.tsx`,
`app/api/admin/[[...path]]/route.ts`, `app/api/cron/{token-refresh,retention,reconcile}/route.ts`,
`scripts/grant-admin.ts`, `firestore.rules`, `storage.rules`, `vercel.json`,
`.env.example` + `lib/env.ts` (updated), `package.json` (firebase dep).
No commits made. No real secrets anywhere.
