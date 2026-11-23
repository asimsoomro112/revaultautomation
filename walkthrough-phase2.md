# Phase 2 Walkthrough — Conversation Engine + Gemini

**Status: COMPLETE** — `npx tsc --noEmit` clean, `npm test` 259/259 green (83 new Phase 2 tests).

## What was built

| File | Purpose |
|---|---|
| `lib/prompts.ts` | All dialogue copy: `intentPrompt`, `visionPrompt` (anti-hallucination), `needsInfoQuestionPrompt`, `consentText` (public-post warning + bot-cannot-delete + removal→admin), `buyerFaqReply`, `sellerGreeting`, `politeReject`, `unsupportedReply`, `humanHandoffReply`, `collectingAck`, `helpText`, `spamWarning`, `listingLimitReply`, `confirmNudge`, `confirmPreviewText`, `submittedReply`, `cancelReply`, `clarifyRetry`; `consentQuickReplies()` + `questionForField()` (enum quick replies + typed fallback lines for desktop). Languages: `ur` (Urdu script), `roman` (default), `en`. |
| `lib/gemini.ts` | `GeminiClient` over `@google/genai`: `classifyIntent`, `extractListing` (ONE multimodal call: all photo buffers as `inlineData` + chat text → extraction + moderation), `writeCaption`, `chatReply`. `GeminiError` with `retryable` flag; schema-validation failures are non-retryable; `resolveModel()` **refuses `gemini-2.5*`** (retires 2026-10-16). |
| `lib/conversation.ts` | Pure helpers (`canTransition`, `setConversationState`, `detectLang`, `isHumanKeyword`, `parseQuickReplyPayload`, `isWithinWindow`, `nextQuestion`, `readyForConfirm`, `coerceFieldValue`/`matchTypedAnswer`/`applyFieldValue`) + injected-`Deps` handlers: `handleMessage`, `ensureActiveListing` (shared with ingest), `moveToConfirm` (shared with finalize), `sendSafe` (never sends outside the 24h window; Meta window errors flip `window_open=false`). |
| `lib/finalize.ts` | `handleFinalizePhotos`: debounce re-arm check (`last_photo_at` must equal payload `photo_at`), downloads bytes via `downloadBytes`, ONE vision call, Phase 3 `applyModeration`, branches FAIL→REJECTED+polite DM / REVIEW→NEEDS_REVIEW+admin alert+holding DM / PASS→NEEDS_INFO or CONFIRM. **Fail closed**: any error (Gemini, download, schema) → NEEDS_REVIEW + alert, never auto-pass. |
| `lib/server-deps.ts` | Real `Deps` wiring (db, `getGeminiClient()`, `getMetaClient()`, `notifyAdmin`, `enqueueWorker`, Phase 3 `buildCaption`, `downloadBytes`). Built at request time, never import time. |
| `app/api/workers/message/route.ts` | QStash-verified → zod `WorkerPayload` → loads persisted inbound by `mid` → `handleMessage`. 401/400/500 semantics; skips (no poison retry) when inbound is missing. |
| `app/api/workers/finalize-photos/route.ts` | Same envelope → `handleFinalizePhotos`. |
| Tests | `conversation.test.ts` (pure helpers), `conversation-handlers.test.ts` (seller/buyer/other routing, consent post/cancel/edit, NEEDS_INFO typed+quick-reply answers, spam 12+1+ignore, human hold-once, blocked, unsupported, window pre-check + Meta window error, duplicate-mid idempotency, listing limit, full IDLE→…→SUBMITTED scripted flow), `prompts.test.ts` (anti-hallucination + consent-warning contracts), `gemini.test.ts` (mocked SDK: 2.5 guard, retryable/non-retryable mapping, bad-JSON/schema/network cases, inlineData parts), `finalize.test.ts` (mocked `applyModeration`: PASS→CONFIRM/NEEDS_INFO, FAIL, REVIEW, re-arm skip, missing/stale listing, Gemini + download failures fail closed). `lib/test-fakes.ts` holds the shared in-memory fakes. |

## Dialogue states

`IDLE → COLLECTING → NEEDS_INFO → CONFIRM → (submit/cancel) → IDLE`, guarded by `canTransition` (illegal jumps logged + refused). Quick-reply payloads: `consent:post|edit|cancel`, `info:<field>:<value>`. Spam: warn once at 13 msgs/hour, then ignore (+ admin alert). Human keyword: flag once + holding reply + alert; further messages held. Consent `post` → SUBMITTED + `publish` enqueued **with no delay** (Phase 4 applies mode/review/slot).

## Handoffs & deviations from the plan

1. **Ingest→message gap closed.** Ingest enqueued `{kind:'message', igsid, mid}` but never persisted the text. Added `saveInboundMessage`/`getInboundMessage` (`inbound_messages/{mid}`, 7d TTL) to `lib/db.ts`; `lib/ingest.ts` takes an **optional** `saveInbound` dep (no break to Phase 1 tests) called before enqueueing; the ingest route wires `saveInboundMessage`.
2. **DbPort adapted to Phase 1's patch API** (`saveConversation(igsid, patch)`, `saveListing(id, patch)`, `createListing`, `appendListingEvent(id, {type,…})`, `newListingId()`, `blankListingDoc()`); defensive backfill of `user_msg_total`/`last_processed_mid`/`chat_text` for pre-existing docs. QStash routes follow the ingest route's verify→parse→dispatch pattern.
3. **`@google/genai` structured output:** the SDK moves `responseSchema` into `config.responseJsonSchema` (v1.9.0+), so `responseSchema` carries the JSON Schema while zod still validates the parsed response client-side. `nullable: true` for nullable fields; the confidence map uses a **fixed key set** (no `additionalProperties` — the backend subset is unreliable there).
4. **Phase 3/4 APIs consumed as landed:** real `applyModeration` (imported, `vi.mock`'d in tests), real `buildCaption`, real `getMetaClient()`/`notifyAdmin`; no stubs written. `types.ts` additions (`chat_text`, `user_msg_total`, `last_processed_mid`) were already synced by the coordinator — no duplicate edits needed.
5. **Cross-phase type fix:** `requireMetaEnv()`'s declared return type `Required<Pick<Env,…>> & Env` didn't actually make the keys non-undefined — `Required<>` strips `?` but not zod v4's `| undefined` unions — so `lib/tokens.ts` failed tsc. Fixed the declared type (and its `as` cast) to `Omit<Env,K> & Record<K,string>`, matching the author's evident intent (the function throws when they're missing). Only callers: `lib/meta.ts`, `lib/tokens.ts` — both still compile.

## Known limits

- Photo-first sellers are greeted/acked by **ingest's** image path, not the message worker — no duplicate greeting by design.
- No `HUMAN_AGENT` tag send — policy violation per plan; window-closed sends are skipped, not forced.
- Quick replies don't render on desktop → every enum question ships a typed fallback ("Ya likh dein: …" / numbered options via `matchTypedAnswer`).
- `lib/finalize.ts` imports real `applyModeration`; tests mock it with `vi.mock("./moderation")`.
