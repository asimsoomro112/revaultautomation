# Phase 4 Walkthrough — Publishing Engine (Meta API client, tokens, slot math, workers)

Date: 2026-09-30. Status: **complete** — 176/176 tests green, `tsc --noEmit` clean
(all Phase 4 files; one unrelated WIP file from a sibling phase has syntax errors —
see §7).

## 1. What was built

### Pure schedule math — `lib/schedule.ts`
- `computeNextSlot(input): Date` implements plan §10 exactly:
  daily cap reached → tomorrow 12:00 PKT; candidate = `max(now, lastPublishAt + gap)`;
  clamp into `[windowStart, windowEnd]` on the PKT calendar day, else next-day 12:00.
- Helpers: `tzParts` / `wallToUtc` (Intl-based, DST-safe iterative conversion),
  `tzDay` (PKT `yyyy-MM-dd` for the daily counter), `tomorrowWindowStart`.

### Meta API client — `lib/meta.ts`
- `getMetaClient()` over `https://graph.instagram.com/v26.0` with per-call
  `getDecryptedToken()` (token never cached; returns `null` + log when absent /
  key missing / decrypt fails → clear "not configured" error instead of a fetch).
- `sendMessage` → `POST /me/messages` (`messaging_type: RESPONSE`, quick replies
  mapped to `{content_type:"text", title≤20, payload}`, 13-reply cap enforced
  client-side). `createImageContainer` (children: `{image_url, is_carousel_item:true}`
  — **no** `media_type`/`caption` on children), `createCarouselContainer`
  (`{media_type:"CAROUSEL", children:"a,b", caption}`), `getContainerStatus`
  (PUBLISHED normalized → FINISHED), `publishContainer` (`media_publish`),
  `getPermalink`, `getPublishingLimit` (parses both the documented
  `{data:[{quota_usage, config:{quota_total}}]}` shape and the unwrapped shape;
  `quota_total` read from `config`, **never hardcoded** — Meta is mid-transition
  50→100).
- Errors → `MetaApiError(code, subcode, status)`; `isWindowError()` matches
  code 10 **or** the 24h-window message text. The HUMAN_AGENT tag is deliberately
  NOT used (human-agents-only policy). 20s timeout per call.

### Tokens — `lib/tokens.ts`
- Thin adapter over Phase 5's `lib/ig-token.ts` (single AES-256-GCM implementation):
  re-exports `encryptToken`/`decryptToken`; `storeToken(plain, expiresAt)` writes
  `{enc, iv, expires_at, updated_at}` + `token_health:"ok"`;
  `refreshLongLivedToken()` → `{ok:true, expires_at}` or `{ok:false}` when no token
  stored **or** token < 24h old (Meta rejects fresh-token refreshes); throws on
  Meta errors so the caller can alert. `exchangeShortLivedToken()` hits the
  unversioned `GET /access_token?grant_type=ig_exchange_token&client_secret=…`.

### DB additions — `lib/db.ts` (additive to Phase 1's file)
- `getDailyPostCount` / `incrementDailyPostCount` (transaction),
  `getLastPublishAt` / `setLastPublishAt` (`counters/publish_meta`),
  `downloadBytes`, `uploadBytes`, `signedReadUrl` (4h TTL, never persisted).
- `blankListingDoc` gains `container_status: {}` and `locked_until: null`.

### Worker plumbing — `lib/workers/common.ts`
- `WorkerDeps` DI interface + `defaultWorkerDeps()` production wiring
  (Firestore tx / Storage / Meta / QStash / Telegram).
- `claimListing`: atomic transaction — SUBMITTED/APPROVED/QUEUED (or stale
  PUBLISHING with expired 10-min lease) → PUBLISHING; returns `preStatus`
  (status before the claim write).
- `liveSettings()` re-reads settings per delivery; throws `KillSwitchEngaged`
  → listing parked (status left PUBLISHING→ saved with `last_error:"killed"`,
  lease cleared, admin notified). `failListing`: attempts++,
  `last_error`, timeline event, Telegram alert, **neutral** seller DM
  (window-error-aware wording), window errors don't retry-send.

### Publish worker — `lib/workers/publish.ts` + `app/api/workers/publish/route.ts`
Order: idempotency first (PUBLISHED → no-op; `media_id` without permalink →
`getPermalink` recovery, never re-`media_publish`) → claim → kill switch →
review-mode gate (**SUBMITTED in review mode → QUEUED** for /admin) → slot math
(future slot → re-enqueue `notBefore`) → live Meta quota (exhausted → reschedule
tomorrow 12:00 PKT + alert) → slides (`slides/{id}/{n}.jpg`, fresh 4h signed URLs)
→ containers (single photo → image+caption; multi → children) → enqueue one
`poll-container` per child (delaySec 30, dedup ids). `dry_run` mode flows
end-to-end but never calls `media_publish` (PUBLISHED with `permalink:null`,
`last_error:"dry_run"`).
- **Bug caught by tests:** the review gate originally compared the *post-claim*
  status (always PUBLISHING) — fixed via `claim.preStatus`.

### Poll-container worker — `lib/workers/poll-container.ts` + route
- Idempotency: PUBLISHED → no-op; `media_id` set → `finalizePublished`.
- Kill-switch park before any Meta call.
- `getContainerStatus`; **subcode 2207027** → treat as IN_PROGRESS (keep polling,
  never recreate); FINISHED → single-photo child publishes directly, otherwise
  waits for all children → creates carousel parent → polls parent → `publishNow`.
- ERROR/EXPIRED → recreate with a fresh signed URL (attempts > 3 → FAILED);
  IN_PROGRESS/transient → backoff `min(30·2^attempt, 300)`s (attempt > 8 → FAILED).
- `publishNow`: `media_id` persisted **before** the permalink fetch; failure after
  `media_publish` → FAILED + alert, **never auto-retried** (see §6).
- `finalizePublished`: bumps daily counter, records last-publish, DMs the seller
  the permalink.

### Types — `lib/types.ts`
- `publish.container_status: Record<string, ContainerStatus>`,
  `publish.locked_until: string | null` (claim lease); new shared
  `DeepPartial<T>` for merge-patch writes (`db.saveListing` widened to it).

## 2. Docs deviations (re-verified 2026-09-30)
- **Subcode 2207027** ("still processing"): docs imply keep polling — added,
  not in the plan.
- Quota parsing reads `quota_total` from nested `config`; both wrapped and
  unwrapped response shapes accepted (the plan only showed one).
- Signed URLs: 4h TTL per plan §1.4 (not 1h) — fresh URL minted on every
  container (re)creation, so expiry can never strand a container.
- HUMAN_AGENT tag deliberately unused; 24h-window failures surface as
  `isWindowError()` and get neutral seller wording instead of retries.

## 3. Test evidence
`npm test`: **15 files, 176/176 pass** (`npx tsc --noEmit`: clean for all
Phase 4 files).
- `lib/schedule.test.ts` (20): before/after-window → today/next-day 12:00 PKT,
  exact 12:00/23:00 boundaries, gap overlap & past-window push, cap reached,
  PKT day rollover, Dec→Jan year rollover, future `lastPublishAt`, no-DST
  (Jan == Jul offset), malformed windows throw.
- `lib/meta.test.ts` (17): request URL/method/body shapes (message, child,
  single, carousel parent, status poll, media_publish, permalink, quota both
  shapes), error code/subcode mapping, window-error detection (code + message),
  no-token misconfiguration error.
- `lib/tokens.test.ts` (11): AES roundtrip, fresh IVs, wrong-key & tamper
  failure, store writes decryptable ciphertext, refresh skips <24h without
  fetch, refresh stores new token ≥24h, exchange URL shape.
- `lib/workers/idempotency.test.ts` (15): **duplicate publish+poll delivery →
  exactly 1 `media_publish`**; crash between `media_publish` and the PUBLISHED
  write recovers via `getPermalink` with 0 additional publishes; lease blocks a
  second concurrent worker; review/kill/future-slot/quota-exhausted/dry_run
  gates; ERROR→recreate, ERROR×4→FAILED+alert+DM, IN_PROGRESS backoff then
  timeout, 2207027 keep-polling, single-photo direct publish.

## 4. Idempotency reasoning (why a post can never double-publish)
1. **Status gate**: PUBLISHED listings no-op on any worker entry.
2. **media_id gate**: if `media_publish` ever succeeded, `media_id` is set and
   persisted *before* the permalink fetch — every later delivery recovers via
   `getPermalink`, never re-publishes.
3. **Atomic claim**: only one worker can hold the 10-min `locked_until` lease;
   losers see `claimed:false` → drop the delivery.
4. **Dedup enqueue ids**: `publish:{id}` and `poll:{listing}:{container}:{role}`
   make QStash redeliveries collapse.
5. **No auto-retry of `media_publish`**: see §6.

## 5. Operational notes
- Routes: `POST /api/workers/publish`, `POST /api/workers/poll-container` —
  `force-dynamic`, raw-body QStash signature check → 401, zod payload → 400,
  handler result → 200, unexpected throw → 500 (QStash retries; handlers
  convert Meta/storage failures into FAILED listings so retries don't storm).
- Token refresh: `refreshLongLivedToken()` is a manual/cron helper — call it
  from Phase 5's admin "refresh now" or a daily cron; it no-ops safely <24h.
- Counters: `counters/daily_posts/{yyyy-MM-dd}` (PKT day) + `counters/publish_meta`.

## 6. Known limitation — `media_publish` is not retry-safe by design
`POST /{ig-user-id}/media_publish` has no idempotency key: **if the HTTP call
throws after Meta actually published server-side, the failure is
indistinguishable from a real failure**, and retrying would create a duplicate
post. So `publishNow` treats *any* `media_publish` throw as terminal: listing
→ FAILED, admin alerted. The alert explicitly tells the admin to **check the IG
profile before any manual retry** — a human glance resolves the ambiguity that
no code can. This trades a rare manual check against the worse outcome
(duplicate posts on a shop page).

## 7. Cross-phase notes for the coordinator
- Additive-only changes to shared files: `lib/db.ts` (counters, bytes,
  signed URLs, `saveListing` widened to `DeepPartial`), `lib/types.ts`
  (`container_status`, `locked_until`, `DeepPartial`), `lib/tokens.ts`
  (adapter over Phase 5's `ig-token.ts`).
- Fixed a strictness error in `lib/log.ts` (spread of `unknown` → cast);
  flagging in case Phase 5 owns it.
- `app/api/workers/{publish,poll-container}/route.ts` are written (were empty
  dirs). `app/api/cron/reconcile/route.ts` (sibling WIP, landed 17:18 with
  unterminated template literal) still breaks `tsc` — not Phase 4's file.
- Still to dedupe (not Phase 4): two Firebase init paths (`db.ts` vs
  `firebase-admin.ts`), `publish-queue.ts` should route via `lib/qstash.ts`,
  `pktDay` (db.ts) vs `tzDay(tz)` (schedule.ts).
- **Do not commit** (per instructions).
