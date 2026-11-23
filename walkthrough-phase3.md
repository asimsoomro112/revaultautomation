# Phase 3 walkthrough — Moderation + image pipeline + caption

**Date:** 2026-09-30 ~22:15 PKT | **Agent:** Phase 3 (senior backend: image processing + AI)
**Deliverables:** `lib/moderation.ts`, `lib/images.ts`, `lib/caption.ts` + 3 test files — all green.

## What was built

| File | Contents |
|------|----------|
| `lib/moderation.ts` | `ModerationOutcome` interface + `applyModeration(listing, vision)` — fail-closed verdict pipeline (blocklist → duplicate check → vision-verdict merge → per-image flag mapping → exception → REVIEW `moderation_error`). Exports `DUP_HAMMING_THRESHOLD = 6`. |
| `lib/images.ts` | `processSlide` (1080×1350 sRGB JPEG, EXIF-rotate, blurred-darkened self-fill, metadata stripped), `dhash` (9×8 grayscale → 64-bit → 16 hex), `hammingDistance`, `brandAssetsAvailable()`, `buildCoverSlide` (satori→sharp, gated, throws `BrandAssetsMissing`), `BrandAssetsMissing` class. |
| `lib/caption.ts` | `buildCaption(extracted, lang)` — Gemini `writeCaption` + deterministic post-processing: CTA line, 3–5 hashtags, phone/email strip, ≤2200 chars. |
| `lib/{moderation,images,caption}.test.ts` | 36 tests, all passing (10 + 19 + 7). |

## Docs re-verified before coding (docs win)

- **sharp** (`sharp(input).rotate()` applies EXIF orientation and drops the EXIF block; `resize(1080,1350,{fit:'cover'|'inside'})`; `.blur(40)` sigma valid; `.modulate({brightness:0.55})`; `.composite([{input, gravity:'center'}])`; `.toColorspace('srgb')`; `.jpeg({quality:85, mozjpeg:true})`. **Never calling `.withMetadata()` strips all metadata incl. GPS** — asserted in tests via `metadata().exif === undefined`.) No contradictions with the plan.
- **satori** (`satori(element, {width, height, fonts})` → SVG string → `sharp(Buffer.from(svg))`). Two API facts confirmed against the installed package (`satori@0.33.5` types): font `weight` must be the `Weight` union (`100|200|…|900`), not `number` — imported `type { Font, FontWeight }` from `"satori"`; and **every `<div>` needs `display:flex`** or satori throws. Both handled.
- **dHash** standard algorithm: 9×8 grayscale, bit = `left < right` left-to-right, MSB-first → 16 hex chars.

## dHash threshold choice: Hamming ≤ 6

- 6/64 bits ≈ 9% — tolerates JPEG recompression/resize/light re-edit of the *same* photo while staying far from genuinely different scenes.
- Empirical anchors from `images.test.ts` (deterministic 9×8 pattern fixtures, no resize ambiguity): identical pattern PNG vs q70 JPEG re-encode → **distance 0**; inverted stripe pattern → **64** (asserted >10); single-pixel flip → **1**, i.e. inside the ≤6 band — exactly the "reposted with a tiny edit" case we want to catch as REVIEW.
- `moderation.test.ts` pins the boundary at the integration level: entry hash differing in 4 bits → `possible_duplicate`; all-`f` vs all-`0` (64) → clean PASS.

## Test evidence

```
npx vitest run lib/images.test.ts lib/moderation.test.ts lib/caption.test.ts
→ 3 files, 36/36 passed (images 10, moderation 19, caption 7)

npx vitest run   (full suite, all phases' tests)
→ 12 files, 133/133 passed, 0 failed

npx tsc --noEmit
→ lib/moderation.ts, lib/moderation.test.ts, lib/images.ts,
  lib/images.test.ts, lib/caption.ts, lib/caption.test.ts: CLEAN.
→ 23 remaining errors are all in OTHER phases' still-in-progress files
  (lib/conversation.ts, lib/db.ts, lib/firebase-admin.ts, lib/log.ts,
  lib/meta.ts, lib/tokens.ts, lib/webhook.ts, lib/webhook.test.ts,
  lib/ingest.test.ts, lib/workers/poll-container.ts, app/admin/*).
  Not touched — owned by concurrent agents.
```

Key assertions: output is exactly 1080×1350 JPEG/sRGB with no EXIF (portrait, EXIF-orientation-6, and small-image cases); a 400×400 green image keeps its centre pixel green after the blurred-bg composite (proves no cropping); full verdict matrix (blocklist, vision FAIL/merge, nudity/minors/offensive→FAIL, faces/contact-info/counterfeit/stock→REVIEW, exact+near duplicates→REVIEW, exceptions→REVIEW); caption guarantees (CTA appended once, 3–5 hashtags, phone/email stripped while `Rs 2500` survives, 2200-char cap, lang+cta passed through to Gemini).

## Judgment calls / deviations from the literal contract

1. **`offensive_text` → FAIL** (not listed in the contract's mapping). Fail-closed rationale: hate speech/abuse has no legitimate listing path; matches plan §7's "polite rejection" for inappropriate content. Test-pinned.
2. **`no_clothing_detected` (all photos `is_clothing=false`) → REVIEW** — new reason, not in the contract. Fail-closed: a non-clothing submission needs human eyes. Test-pinned.
3. **`lib/db.ts`**: Phase 1's full version landed mid-build and replaced my minimal stub. Their API converged with mine (`isSellerBlocklisted`, `findRecentPhashes(sinceDays=90, limit=500)`, `recordPhash`) and explicitly provides `findDuplicatePhashEntry(phash): Promise<DupEntry|null>` "for the moderation pipeline" — moderation uses that (exact match), `findDuplicatePhash(phash): Promise<string|null>` (listing-id shorthand) left for other callers. My stub is gone; nothing of Phase 3 was lost.
4. **`lib/types.ts` drift**: `ListingDoc.publish` gained `container_status` and `locked_until`, plus `chat_text` (Phase 2/4) — test fixture updated twice to track. Cross-phase note: types are a moving contract; I re-read before each test run.
5. **Caption hashtag trim**: model outputs >5 hashtags are trimmed to the first 5 (plan §9 house style ≤5), and the append branch only emits *new* derived tags (avoids duplicating the model's inline tags).
6. **Malformed phashes** in duplicate check are skipped with a warn log (not REVIEW): the duplicate check is an advisory REVIEW signal only, never a PASS blocker — a corrupt hash shouldn't nuke listings. Documented in code.

## Handoffs

- **Phase 2** (`finalize-photos` worker): import `applyModeration(listing, vision)` and `buildCaption(extracted, lang)`. `applyModeration` reads `blocklist/` + `phash_index/`; it never writes. After a listing clears intake, call Phase 1's `recordPhash(phash, listingId)` per photo (provided by `lib/db.ts`) — moderation deliberately does not record.
- **Phase 4** (`publish` worker): import `processSlide(input)` for each raw photo → upload to `slides/{listingId}/{n}.jpg`; optional `buildCoverSlide({price_pkr, size, condition, title})` ONLY behind `brandAssetsAvailable()` (currently `false` — `/brand` has no `colours.json`; `COVER_SLIDE_ENABLED=false`). Never call it unconditionally.
- **Env knobs consumed**: `CAPTION_CTA` (`dm`|`site`), `COVER_SLIDE_ENABLED`. No new env vars added.

## Known limits

- Cover slide is untestable end-to-end until Asim provides `/brand/colours.json` (+ fonts in `/brand/fonts/` or system fonts); the throw path is tested.
- `processSlide` on HEIC/animated input is untested (sharp decodes first frame; IG attachments are JPEG/PNG in practice).
- Duplicate index reads are one bounded query (90d, 500 rows) per finalize — fine at our volume; revisit if listings/day grows 10×.
- `tsc --noEmit` repo-wide is blocked by other phases' in-progress type errors (listed above) — my files are clean and the full test suite is green.
