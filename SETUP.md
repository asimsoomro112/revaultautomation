# SETUP.md — ReVault DM-to-Post Bot, click-by-click

Do these in order. Steps marked **[Asim]** need a human login — everything else
is copy-paste. Nothing here needs a second Instagram account for testing
(Self Messaging covers it — see `LIVE_TEST.md`).

Assumed defaults (decided during the unattended build; change any of them):
new Firebase project, dedicated new Telegram bot, `PUBLISH_MODE=review`,
cover slide OFF until you send logo/colours/voice.

---

## 1. Meta app + Instagram API with Instagram Login **[Asim]**

1. Go to <https://developers.facebook.com/apps> → **Create App** → choose
   **"Other"** → **Business** type. Name it e.g. `ReVault DM Bot`.
2. In the app dashboard → **Add Product** → **Instagram** (the *Instagram API
   with Instagram Login* product — **not** the old Instagram Graph API).
3. **API setup with Instagram Login:**
   - Add the Instagram professional account `@therevaultofficial` and complete
     the Instagram Login OAuth flow as that account.
   - Request scopes: `instagram_business_basic`,
     `instagram_business_manage_messages`,
     `instagram_business_content_publish`.
4. **App Role:** in *Roles* → add yourself (and any reviewer) as Admin/Developer.
   Test users must accept the role invite.
5. **Token:** in the Instagram product → generate a **short-lived (~1h) token**
   for the `@therevaultofficial` user. The app exchanges it for a 60-day
   long-lived token automatically on first `/api/cron/token-refresh` run —
   but easiest: paste the short-lived token into the `admin_settings` doc
   via `/admin` → Token health → the app handles exchange + encrypted storage.
   (The 60-day refresh then runs itself every night.)
6. **Stay in Development mode** until `LIVE_TEST.md` passes; then flip the app
   to **Live mode** (top toggle in the app dashboard).
7. **Webhook:** *Webhooks* product (or Instagram product → Webhooks) →
   **Subscribe** to the `messages` field:
   - Callback URL: `https://<your-vercel-domain>/api/webhooks/instagram`
   - Verify token: the same string you put in `IG_VERIFY_TOKEN` (generate:
     `openssl rand -hex 16`).
   - Meta will GET the URL with `hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`
     — the route answers the challenge only when the token matches.

**Env values from this step:** `IG_APP_ID`, `IG_APP_SECRET`, `IG_VERIFY_TOKEN`,
`IG_USER_ID` (the numeric professional-account id — shown in the Instagram
product after login; also returned by `GET /me?fields=user_id`).

---

## 2. Firebase project (new) **[Asim]**

1. <https://console.firebase.google.com> → **Add project** → name it e.g.
   `revault-dm-bot` → disable Analytics (optional).
2. **Build → Firestore Database → Create database** → production mode →
   region `asia-south1` (closest to PKT users).
3. **Deploy the rules in this repo** (they deny everything except the admin claim):
   ```bash
   firebase deploy --only firestore:rules   # firestore.rules
   ```
   (Or paste them in Console → Firestore → Rules and Publish.)
   > Photo storage moved to **Cloudinary** (2026-10-01) — there is no
   > `storage.rules` anymore and the Firebase **Storage** product is not used
   > at all, so skip any Storage setup in the Firebase console.
4. **TTL policies (required):** Console → Firestore → the `processed_webhooks`
   collection → add TTL on field `expire_at`; same for `inbound_messages.expire_at`.
   Without this the dedupe tables grow forever.
5. **Service account:** Project settings → Service accounts → **Generate new
   private key** → JSON downloads. From it take:
   `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`
   (the private key with literal `\n` escapes — paste as one line).
6. **Web app for /admin sign-in:** Project settings → *Your apps* → **Web** →
   register → copy the config values into `NEXT_PUBLIC_FIREBASE_API_KEY`,
   `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`.
   Enable **Authentication → Sign-in method → Google**.

> **No Firebase Storage setup needed** — photos live in Cloudinary (step 4b).
> Firestore (database) and Auth (admin login) are the only Firebase products
> in use, both comfortably inside the free tier.

---

## 3. Grant yourself admin **[Asim]**

1. Deploy once (step 5), then sign in at `https://<domain>/admin` with your Google
   account (you'll see "Access denied" — expected).
2. Run once, locally or in Vercel:
   ```bash
   npm run grant-admin -- you@gmail.com
   ```
   (uses the Firebase Admin env vars; sets custom claim `admin: true`).
   Alternative: put your email in `ADMIN_EMAILS` — first sign-in via the
   allowlist is logged and grants access for bootstrapping.

---

## 4. Gemini API key **[Asim]**

1. <https://aistudio.google.com/apikey> → **Create API key**.
2. `GEMINI_API_KEY=<key>`. `GEMINI_MODEL` defaults to `gemini-3.8-flash`
   (verified 2026-09-30 against ai.google.dev — current stable flagship;
   set `gemini-3.5-flash` for the cheaper tier).

---

## 4b. Cloudinary — photo storage (free) **[Asim]**

Photos live here, not in Firebase. The free tier gives **25 pooled
credits/month** (1 credit = 1GB storage *or* 1GB bandwidth *or* 1000
transformations) with **no credit card** required — our math: even
1000 listings × 9 photos × ~200KB ≈ **1.8GB ≈ ~2 credits**.

1. <https://cloudinary.com> → **Sign up** (free) → open the **Dashboard**.
2. Copy **Cloud name**, **API key**, **API secret** →
   `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`.
   (The secret stays server-side — never prefix it with `NEXT_PUBLIC_`.)
3. Nothing else to configure: uploads are server-signed by the app into the
   `revault/listings/` folder as **private** assets; delivery URLs are
   time-limited (~4h) and generated on demand.

---

## 5. Upstash QStash **[Asim]**

1. <https://console.upstash.com> → **QStash** → create → copy the **token**.
2. The token encodes the signing keys; also copy **Current signing key** and
   **Next signing key** separately.
3. `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`.
   All worker routes verify the QStash signature (current + next keys).

---

## 6. Telegram alerts (dedicated bot) **[Asim]**

1. Message **@BotFather** → `/newbot` → name it e.g. `ReVault Alerts` →
   copy the token → `TELEGRAM_BOT_TOKEN`.
2. Message your new bot anything, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` → copy your numeric
   `chat.id` → `TELEGRAM_ADMIN_CHAT_ID`.
3. Until both are set, alerts are a safe no-op (logged, never thrown).

---

## 7. Vercel deploy **[Asim]**

1. <https://vercel.com/new> → import this repo → framework **Next.js**.
2. **Environment Variables:** paste every value from `.env.example`
   (all of them — the app fails fast with a clear error naming any missing one).
   Also generate: `IG_TOKEN_ENC_KEY` (`openssl rand -hex 32`),
   `CRON_SECRET` (`openssl rand -hex 32`).
   Set `APP_BASE_URL=https://<your-domain>`.
3. Deploy. `vercel.json` wires the crons (token-refresh 08:00, retention 08:30,
   reconcile 05:00/11:00/17:00/23:00 PKT); Vercel sends
   `Authorization: Bearer $CRON_SECRET` automatically.
4. Point the Meta webhook callback URL at the real domain (step 1.7).

---

## 8. Go-live checklist

- [ ] `GET /api/health` → `{ ok: true, ... }`
- [ ] `/admin` sign-in works, kill switch visible, token health shows expiry
- [ ] `LIVE_TEST.md` walked end-to-end (Self Messaging) in `dry_run`, then `review`
- [ ] Test Telegram alert received (trigger: submit a listing that needs review)
- [ ] Firestore TTL policies set on `processed_webhooks.expire_at` + `inbound_messages.expire_at`
- [ ] App flipped to **Live mode** in the Meta dashboard
- [ ] `PUBLISH_MODE` set to `review` (keep it there until the first week is clean)
- [ ] First real seller listing approved from `/admin` → post appears → seller gets permalink DM

**Roll back / stop everything:** flip the kill switch in `/admin`
(or set `global_kill_switch: true` in `admin_settings/global`) — every worker
checks it before doing anything.
