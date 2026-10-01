# LIVE_TEST.md — end-to-end test with Instagram Self Messaging

Meta documents **Self Messaging**: the professional account `@therevaultofficial`
can DM **itself** — so you can walk the entire flow with no second account.

**Before starting:** `SETUP.md` steps 1–7 done, app in **Development mode**,
`PUBLISH_MODE=dry_run` in `/admin` → Settings (dry run executes everything
except the final `media_publish`).

## The walkthrough

### 1. Subscribe + handshake
- In the Meta app dashboard, subscribe the webhook to `messages`
  (callback `https://<domain>/api/webhooks/instagram`).
- Meta's GET challenge must return 200 (check Vercel logs).

### 2. Seller flow (from the @therevaultofficial account, DM to itself)
1. Send **3 photos** of a test item (e.g. a jacket) in one burst.
2. Wait ~30s (photo debounce = 25s) → the bot replies with **one consolidated
   question** for whatever the vision call couldn't extract
   (e.g. price / size / city).
3. Answer the questions (try quick-reply buttons AND typed answers —
   quick replies don't render on desktop, typed fallbacks must work).
4. You get a **preview + consent prompt**: *"I'll post this publicly…"*
   with **Post / Edit / Cancel** buttons.
5. Tap **Post** → listing becomes `SUBMITTED`. In `dry_run` mode the publish
   worker runs the whole pipeline and logs `dry_run: would publish` —
   **no post appears** (correct).
6. In `/admin` → Queue you should see the full trail; in Publish log the
   dry-run entry.

### 3. Moderation paths (send as separate test listings)
- **REVIEW:** send a photo with your face visible → listing goes `NEEDS_REVIEW`,
  you get a Telegram alert + holding DM.
- **FAIL:** send an obvious non-clothing photo → polite rejection DM, no alert.
- **Duplicate:** resend the exact same 3 photos as a new listing → second
  listing flagged `possible_duplicate` → REVIEW.

### 4. Flip to review mode + real publish
1. `/admin` → Settings → `PUBLISH_MODE=review`.
2. Send a fresh clean listing, walk it to `SUBMITTED`.
3. `/admin` → Queue → **Approve** → the publish worker picks the next PKT slot
   (12:00–23:00 window, 90-min gap) → carousel posts → you get the permalink
   in the DM thread and in `/admin` → Publish log.
4. Verify the post on the profile: 1080×1350 slides, caption + hashtags,
   no phone/email in the caption.

### 5. Kill switch + failure drills
- Flip the **kill switch** in `/admin` mid-queue → workers park jobs with
  `last_error: "killed"` and alert Telegram. Flip back → retry from `/admin`.
- Revoke the IG token in Meta dashboard → next publish fails → `FAILED` +
  neutral DM to seller + Telegram alert → fix token → **Retry** from `/admin`
  (idempotency: never double-posts).

### 6. Go live
When everything above passes: Meta app → **Live mode** → keep
`PUBLISH_MODE=review` for the first week.

## The /admin browser check (screenshots)
Open `https://<domain>/admin` in a real browser: sign-in screen → Google
sign-in → queue with photo previews → approve a listing → kill-switch confirm
dialog → token health panel. Attach screenshots to the phase walkthrough
(this needs a logged-in browser session, so it's a manual step).

## Cleanup
Delete the test posts from the Instagram profile afterwards. Test listings
stay in Firestore (useful as fixtures); wipe them from `/admin` if you want
a clean queue.
