# verify.md — full verification workflow

Run these in order. Stop at the first failure and fix it before continuing.

## 1. Secret scan

```bash
git diff --cached --name-only | xargs grep -lE 'AIza|-----BEGIN (RSA )?PRIVATE KEY|sk_live|ghp_|xoxb-|AKIA' || true
```

Must print nothing. Also verify no `.env*` file is staged:
`git status --short | grep -E '^\S+\s+\.env' || echo "no .env staged"`.

## 2. Typecheck

```bash
npx tsc --noEmit
```

Strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`-style care).
Zero errors required.

## 3. Tests

```bash
npm test
```

All 262 vitest tests must pass. Tests are fully mocked — no network, no spend.
If you touched worker/publish/moderation logic, also run the idempotency and
fail-closed suites explicitly:
`npx vitest run lib/workers/idempotency.test.ts lib/moderation.test.ts lib/finalize.test.ts`.

## 4. Fixture replay (optional, when webhook/ingest changed)

```bash
npm run dev &           # in one shell
npm run replay -- --fixture multi-image-burst --verify
```

## Pass criteria

Secret scan clean + `tsc` zero errors + `npm test` all green = safe to commit.
