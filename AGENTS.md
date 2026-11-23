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
9. **Gemini:** model from `GEMINI_MODEL` env (default `gemini-3.8-flash`,
   verified 2026-09-30). **Never `gemini-2.5*`** — `lib/gemini.ts` refuses it
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
npm test                    # vitest, 262 tests, fully mocked
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

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
