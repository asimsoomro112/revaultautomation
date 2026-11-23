/**
 * Prompt builders + localized reply templates for the ReVault DM-to-Post bot.
 *
 * Languages: 'ur' (Urdu script), 'roman' (Roman Urdu + English mix — the
 * default, friendly and short), 'en' (English). Every user-facing string is
 * produced here so the conversation engine stays logic-only.
 */
import type { ExtractedItem, Lang } from "./types";
import type { QuickReply } from "./meta";

export const LANG_NAMES: Record<Lang, string> = {
  ur: "Urdu (اردو رسم الخط)",
  roman: "Roman Urdu (Urdu written in Latin script, mixed with English)",
  en: "English",
};

// ---------------------------------------------------------------------------
// Gemini prompts (input to the model)
// ---------------------------------------------------------------------------

/** Classify a newly-seen conversation: seller vs buyer vs other (+ language). */
export function intentPrompt(text: string, history: string[]): string {
  const hist = history.length > 0 ? `\nEarlier messages from this user:\n${history.map((h) => `- ${h}`).join("\n")}` : "";
  return `You classify Instagram DMs for ReVault, a preloved fashion marketplace in Pakistan.

Message: "${text}"${hist}

Classify the user's INTENT:
- SELLER_SUBMIT: the user wants to SELL / list a preloved clothing or fashion item (mentions selling, posting an item, sends or will send item photos, asks how to sell/list).
- BUYER_QUESTION: the user wants to BUY or asks about buying (price of a posted item, availability, delivery, "is this available", how to order).
- OTHER: greetings with no clear intent, spam, or anything else.

Also detect the reply LANGUAGE the bot should mirror:
- "ur": message is written in Urdu script (اردو).
- "roman": message is Roman Urdu (Urdu in Latin letters, often mixed with English) — e.g. "mujhe apni kurti sell karni hai", "price kya hai".
- "en": plain English.

Reply with JSON only: {"intent": "SELLER_SUBMIT" | "BUYER_QUESTION" | "OTHER", "lang": "ur" | "roman" | "en", "confidence": 0.0-1.0}.
Be decisive: short sales-y messages ("kurti sell karni hai", "dress hai mere pas") are SELLER_SUBMIT.`;
}

/**
 * Vision prompt for the ONE multimodal finalize call: structured extraction +
 * moderation verdict. Carries the anti-hallucination contract.
 */
export function visionPrompt(chatText: string, lang: Lang): string {
  return `You are ReVault's listing analyst AND safety moderator. You receive PHOTOS of a preloved fashion item plus the seller's chat text. Analyse ALL photos together and reply with ONE single JSON object (no markdown fences, no commentary).

SELLER CHAT TEXT (language: ${LANG_NAMES[lang]} — extract facts regardless of language):
"""
${chatText || "(no text yet)"}
"""

CRITICAL — NEVER HALLUCINATE:
- "brand": set ONLY if a brand name/tag/logo is CLEARLY visible in a photo or explicitly stated by the seller. Otherwise null. NEVER guess a brand from style alone.
- "size": set ONLY if visible on a tag or stated by the seller. Otherwise null. NEVER estimate size from the photo.
- "price_pkr": set ONLY if the seller stated a price (number, PKR/Rs). Otherwise null. NEVER invent a price.
- "city": set ONLY if the seller stated it. Otherwise null.
- Every field gets a "confidence" score 0.0-1.0. Any field with confidence < 0.6 (or null) MUST appear in "missing".

EXTRACTION — fill what you can:
- "title": short listing title, e.g. "Embroidered lawn kurti". Always provide your best short title.
- "category": one of: kurti, dress, abaya, shirt, tshirt, jeans, trousers, shoes, bag, hijab, saree, lehenga, jacket, other (lowercase).
- "gender": "women" | "men" | "unisex" | null (infer ONLY if obvious from the garment, else null).
- "color": main color(s), e.g. "black", "maroon and gold".
- "condition": "new" | "like_new" | "good" | "fair" | null — from photos + seller words ("new", "bilkul new", "used", "thoda used").
- "defects": list of visible/stated flaws, e.g. ["small stain on sleeve"]. Empty array if none visible or stated — write "none stated" is NOT needed, use [].
- "measurements": e.g. "chest 38, length 42" if stated/visible, else null.
- "missing": array of field names (from: category, size, condition, price_pkr, city, gender, color) that are null or low-confidence.

MODERATION — per photo (photo_index 0-based, in the order received) flag:
- "is_clothing": is this photo a clothing/fashion item (or clearly related, e.g. shoes/bag)?
- "nudity_sexual": nudity, sexual content, underwear/lingerie shots.
- "visible_faces": a person's face clearly visible.
- "minors": anyone who looks under 18.
- "offensive_text": hateful, abusive or obscene text visible in the image.
- "contact_info": phone number, email, address or social handle visible IN THE IMAGE.
- "stock_or_stolen_suspicion": looks like a stock/catalogue photo, screenshot, or watermarked repost rather than the seller's own photo.
Also overall:
- "counterfeit_claim": seller claims "first copy", "replica", "master copy", or a visible brand tag contradicts the claimed brand.
- "text_contact_info": phone/email/address/social handle in the CHAT TEXT.

VERDICT:
- "FAIL" if: nudity_sexual, minors, not clothing at all (and not fashion-related), contact info in image or text, counterfeit claims. The listing is rejected.
- "REVIEW" if: visible faces, possible stock/stolen image, uncertain brand, offensive text — a human admin should decide.
- "PASS" otherwise.
- "reasons": short English phrases explaining the verdict, e.g. ["face visible in photo 1", "possible stock image"].

JSON SHAPE (return exactly this):
{
  "extracted": {
    "title": "string",
    "category": "string|null", "gender": "string|null", "brand": "string|null",
    "color": "string|null", "size": "string|null",
    "condition": "new|like_new|good|fair|null",
    "price_pkr": "number|null", "city": "string|null",
    "defects": ["string"], "measurements": "string|null",
    "confidence": {"title": 0.9, "category": 0.8}
  },
  "missing": ["size", "price_pkr"],
  "moderation": {
    "verdict": "PASS|REVIEW|FAIL",
    "reasons": ["..."],
    "counterfeit_claim": false,
    "text_contact_info": false,
    "per_image": [{"photo_index": 0, "is_clothing": true, "nudity_sexual": false, "visible_faces": false, "minors": false, "offensive_text": false, "contact_info": false, "stock_or_stolen_suspicion": false}]
  }
}`;
}

/** Prompt for Gemini to write ONE short follow-up question (ad-hoc fields). */
export function needsInfoQuestionPrompt(missing: string[], lang: Lang): string {
  return `You are ReVault's friendly Instagram DM assistant (preloved fashion marketplace, Pakistan).
The seller still needs to provide: ${missing.join(", ")}.
Write ONE short follow-up question in ${LANG_NAMES[lang]} asking for the MOST important missing item ("${missing[0] ?? "details"}").
Rules: under 25 words, warm and casual, no greeting, no hashtags. Output ONLY the question text, no quotes.`;
}

// ---------------------------------------------------------------------------
// User-facing localized templates
// ---------------------------------------------------------------------------

export function sellerGreeting(lang: Lang): string {
  switch (lang) {
    case "ur":
      return (
        "السلام علیکم! 👋 میں ReVault کا اسسٹنٹ ہوں — آپ کی پریلووڈ آئٹمز یہاں پوسٹ کرنے میں مدد کروں گا۔\n\n" +
        "مجھے چاہیے:\n📸 2 یا زیادہ صاف تصاویر (پوری آئٹم نظر آئے)\n📏 سائز\n✨ کنڈیشن\n💰 قیمت (PKR)\n📍 شہر\n\n" +
        "⚠️ نوٹ: پوسٹس PUBLIC ہوتی ہیں — تصاویر اور تفصیل سب دیکھ سکتے ہیں۔\n\n" +
        "پہلے تصاویر بھیج دیں، باقی تفصیل میں خود پوچھ لوں گا!"
      );
    case "en":
      return (
        "Hi! 👋 I'm ReVault's assistant — I'll help you list your preloved items here.\n\n" +
        "I'll need:\n📸 2+ clear photos (full item visible)\n📏 Size\n✨ Condition\n💰 Price (PKR)\n📍 City\n\n" +
        "⚠️ Note: posts are PUBLIC — everyone can see your photos and details.\n\n" +
        "Send the photos first; I'll ask for the rest!"
      );
    case "roman":
    default:
      return (
        "Assalam-o-Alaikum! 👋 Main ReVault ka assistant hun — aapki preloved items yahan post karne me help karunga.\n\n" +
        "Mujhe chahiye:\n📸 2+ clear photos (full item nazar aaye)\n📏 Size\n✨ Condition\n💰 Price (PKR)\n📍 City\n\n" +
        "⚠️ Note: posts PUBLIC hoti hain — photos aur details sab dekh sakte hain.\n\n" +
        "Pehle photos bhej dein, baqi details me khud puch lunga!"
      );
  }
}

/**
 * Consent text: public warning + bot cannot delete + removal goes to admin.
 * Sent with the Post/Edit/Cancel quick replies at CONFIRM time.
 */
export function consentText(lang: Lang): string {
  switch (lang) {
    case "ur":
      return (
        "⚠️ آخری تصدیق\n\n'Post it' دبانے پر:\n" +
        "• آپ کی تصاویر + تفصیل ReVault پیج پر PUBLIC پوسٹ ہوگی\n" +
        "• پوسٹ کو میں (بوٹ) DELETE نہیں کر سکتا\n" +
        "• ہٹانی ہو تو ایڈمن سے رابطہ کرنا ہوگا\n\n" +
        "متفق ہیں تو '✅ Post it' دبائیں۔"
      );
    case "en":
      return (
        "⚠️ FINAL CONFIRMATION\n\nIf you tap 'Post it':\n" +
        "• Your photos + details will be posted PUBLICLY on the ReVault page\n" +
        "• I (the bot) CANNOT delete the post afterwards\n" +
        "• To remove it, you'll need to contact the admin\n\n" +
        "If you agree, tap '✅ Post it'."
      );
    case "roman":
    default:
      return (
        "⚠️ FINAL CONFIRMATION\n\n'Post it' dabane par:\n" +
        "• Aapki photos + details ReVault page par PUBLIC post hongi\n" +
        "• Post ko main (bot) DELETE nahi kar sakta\n" +
        "• Hatani ho to admin se contact karna hoga\n\n" +
        "Agree hain to '✅ Post it' dabayein."
      );
  }
}

const DEFAULT_FAQ: Record<Lang, string> = {
  roman:
    "ReVault preloved fashion marketplace hai! 🛍️\n\n" +
    "• Jo item pasand aaye, us par DM karein — 'BUY' likh dein\n" +
    "• Payment advance hoti hai, delivery all over Pakistan\n" +
    "• Har item preloved hai — condition post me likhi hoti hai\n\n" +
    "Koi specific item dhund rahe hain? Page visit karein ya yahin puch lein!",
  ur:
    "ReVault پریلووڈ فیشن مارکیٹ پلیس ہے! 🛍️\n\n" +
    "• جو آئٹم پسند آئے اس پر DM کریں — 'BUY' لکھ دیں\n" +
    "• پیمنٹ ایڈوانس ہوتی ہے، ڈیلیوری آل پاکستان\n" +
    "• ہر آئٹم پریلووڈ ہے — کنڈیشن پوسٹ میں لکھی ہوتی ہے",
  en:
    "ReVault is a preloved fashion marketplace! 🛍️\n\n" +
    "• To buy an item, DM us with 'BUY'\n" +
    "• Payment is in advance, delivery all over Pakistan\n" +
    "• Every item is preloved — condition is stated in the post\n\n" +
    "Looking for something specific? Browse the page or just ask here!",
};

/** Buyer FAQ reply (+ CTA). `faq` overrides the built-in text (from admin settings). */
export function buyerFaqReply(lang: Lang, faq?: string): string {
  return faq?.trim() ? faq.trim() : DEFAULT_FAQ[lang];
}

/** Polite rejection naming the reason category (no lecture). */
export function politeReject(reason: string, lang: Lang): string {
  const r = reason.trim();
  switch (lang) {
    case "ur":
      return `معذرت! 🙏 یہ لسٹنگ پوسٹ نہیں ہو سکتی: ${r}\nReVault صرف پریلووڈ کپڑے اور فیشن آئٹمز پوسٹ کرتا ہے۔ کوئی اور آئٹم ہو تو دوبارہ بھیج دیں!`;
    case "en":
      return `Sorry! 🙏 This listing can't be posted: ${r}\nReVault only posts preloved clothing & fashion items. Have another item? Send it over!`;
    case "roman":
    default:
      return `Maazrat! 🙏 Yeh listing post nahi ho sakti: ${r}\nReVault sirf preloved clothing & fashion items post karta hai. Koi aur item ho to dobara bhej dein!`;
  }
}

/** Holding reply while the listing waits for human admin review. */
export function reviewHoldReply(lang: Lang): string {
  switch (lang) {
    case "ur":
      return "آپ کی لسٹنگ ہماری ٹیم چیک کر رہی ہے 👀 تھوڑا انتظار کریں، جلد اپڈیٹ ملے گی!";
    case "en":
      return "Our team is reviewing your listing 👀 Please wait a little — you'll get an update soon!";
    case "roman":
    default:
      return "Aapki listing hamari team check kar rahi hai 👀 Thora wait karein, jald update milegi!";
  }
}

/** Reply for unsupported attachments (video/sticker/audio/gif). */
export function unsupportedReply(hint: string, lang: Lang): string {
  const h = hint.trim() || "yeh format";
  switch (lang) {
    case "ur":
      return `تصاویر امیج کی صورت میں بھیجیں 📸 (${h} سپورٹ نہیں ہوتا)۔ 2 یا زیادہ صاف تصاویر چاہیے ہوں گی!`;
    case "en":
      return `Please send photos as images 📸 (${h} isn't supported). I'll need 2+ clear photos!`;
    case "roman":
    default:
      return `Photos image ki surat me bhej dein 📸 (${h} support nahi hota). 2+ clear photos chahiye hongi!`;
  }
}

/** Holding reply when the seller asks for a human. */
export function humanHandoffReply(lang: Lang): string {
  switch (lang) {
    case "ur":
      return "بالکل! میں نے آپ کی ریکویسٹ ٹیم کو بھیج دی ہے 🙏 تھوڑی دیر میں کوئی آپ سے رابطہ کرے گا۔";
    case "en":
      return "Of course! I've passed your request to the team 🙏 Someone will reach out shortly.";
    case "roman":
    default:
      return "Bilkul! Maine aapki request team ko bhej di hai 🙏 Thori der me koi aap se contact karega.";
  }
}

/** Brief ack while still collecting (photos/details trickling in). */
export function collectingAck(lang: Lang): string {
  switch (lang) {
    case "ur":
      return "نوٹ کر لیا 👍 بس 2 یا زیادہ صاف تصاویر بھیج دیں!";
    case "en":
      return "Noted 👍 Just send 2+ clear photos when ready!";
    case "roman":
    default:
      return "Note kar liya 👍 Bas 2+ clear photos bhej dein!";
  }
}

/** Generic help text for OTHER intents. */
export function helpText(lang: Lang): string {
  switch (lang) {
    case "ur":
      return "میں ReVault کا لسٹنگ اسسٹنٹ ہوں! 👗\nبیچنا ہے؟ اپنی آئٹم کی 2+ تصاویر بھیجیں۔\nخریدنا ہے؟ بس آئٹم کا نام لکھیں۔";
    case "en":
      return "I'm ReVault's listing assistant! 👗\nSelling? Send 2+ photos of your item.\nBuying? Just name the item you're looking for.";
    case "roman":
    default:
      return "Main ReVault ka listing assistant hun! 👗\nBechna hai? Apni item ki 2+ photos bhej dein.\nKharidna hai? Bas item ka naam likh dein.";
  }
}

/** Spam warning (first time crossing the rate limit). */
export function spamWarning(lang: Lang): string {
  switch (lang) {
    case "ur":
      return "تھوڑا آہستہ! 🙏 آپ بہت تیزی سے میسج بھیج رہے ہیں۔ ایک گھنٹے بعد دوبارہ کوشش کریں۔";
    case "en":
      return "Slow down a little! 🙏 You're sending messages too fast. Please try again in an hour.";
    case "roman":
    default:
      return "Thora slow! 🙏 Aap bohat tezi se messages bhej rahe hain. Ek ghante baad dobara try karein.";
  }
}

/** Daily listing limit reached. */
export function listingLimitReply(lang: Lang, max: number): string {
  switch (lang) {
    case "ur":
      return `آج کی حد پوری ہو گئی! 🙏 ایک دن میں زیادہ سے زیادہ ${max} لسٹنگز بھیج سکتے ہیں۔ کل دوبارہ کوشش کریں۔`;
    case "en":
      return `Daily limit reached! 🙏 You can send up to ${max} listings per day. Please try again tomorrow.`;
    case "roman":
    default:
      return `Aaj ki limit puri ho gayi! 🙏 Ek din me max ${max} listings bhej sakte hain. Kal dobara try karein.`;
  }
}

/** Nudge when the user types free text while at the CONFIRM step. */
export function confirmNudge(lang: Lang): string {
  switch (lang) {
    case "ur":
      return "نیچے بٹن سے منتخب کریں 👇 پوسٹ کرنا ہے، تبدیل کرنا ہے، یا منسوخ؟";
    case "en":
      return "Please choose below 👇 Post it, edit, or cancel?";
    case "roman":
    default:
      return "Neeche button se choose karein 👇 Post karna hai, edit karna hai, ya cancel?";
  }
}

/** Text summary + caption draft sent at CONFIRM time (before consent buttons). */
export function confirmPreviewText(extracted: ExtractedItem, caption: string, lang: Lang): string {
  const e = extracted;
  const lines: string[] = [];
  const t = (ro: string, u: string, en: string) => (lang === "ur" ? u : lang === "en" ? en : ro);
  lines.push(t("📋 Aapki listing ka preview:", "📋 آپ کی لسٹنگ کا پریویو:", "📋 Your listing preview:"));
  if (e.title) lines.push(`• ${e.title}`);
  const bits: string[] = [];
  if (e.category) bits.push(e.category);
  if (e.size) bits.push(t(`Size: ${e.size}`, `سائز: ${e.size}`, `Size: ${e.size}`));
  if (e.condition) bits.push(e.condition.replace("_", " "));
  if (e.price_pkr != null) bits.push(`Rs ${e.price_pkr.toLocaleString("en-PK")}`);
  if (e.city) bits.push(e.city);
  if (bits.length > 0) lines.push(`• ${bits.join(" · ")}`);
  if (e.defects.length > 0) {
    lines.push(t(`• Defects: ${e.defects.join(", ")}`, `• خامیاں: ${e.defects.join(", ")}`, `• Defects: ${e.defects.join(", ")}`));
  }
  lines.push("", t("📝 Caption draft:", "📝 کیپشن کا مسودہ:", "📝 Caption draft:"), caption);
  return lines.join("\n");
}

/** Quick replies for the consent step. Titles ≤ 20 chars (Meta truncates). */
export function consentQuickReplies(): QuickReply[] {
  return [
    { title: "✅ Post it", payload: "consent:post" },
    { title: "✏️ Edit", payload: "consent:edit" },
    { title: "❌ Cancel", payload: "consent:cancel" },
  ];
}

/** Thanks after consent recorded (publish worker takes it from here). */
export function submittedReply(lang: Lang): string {
  switch (lang) {
    case "ur":
      return "شکریہ! ✅ آپ کی لسٹنگ جمع ہو گئی ہے۔\nٹیم کے ریویو کے بعد یہ ReVault پیج پر پوسٹ ہوگی — لنک آپ کو یہیں بھیج دوں گا! 🎉";
    case "en":
      return "Thank you! ✅ Your listing has been submitted.\nAfter the team's review it will be posted on the ReVault page — I'll send you the link here! 🎉";
    case "roman":
    default:
      return "Shukriya! ✅ Aapki listing submit ho gayi hai.\nTeam ke review ke baad yeh ReVault page par post hogi — link aapko yahin bhej dunga! 🎉";
  }
}

/** Polite close after the seller cancels at CONFIRM. */
export function cancelReply(lang: Lang): string {
  switch (lang) {
    case "ur":
      return "کوئی بات نہیں! لسٹنگ منسوخ کر دی ہے۔ جب چاہیں نئی لسٹنگ بھیج سکتے ہیں 👍";
    case "en":
      return "No problem! The listing has been cancelled. Send a new one whenever you like 👍";
    case "roman":
    default:
      return "Koi baat nahi! Listing cancel kar di hai. Jab chahein nayi listing bhej sakte hain 👍";
  }
}

/** Retry line when a typed answer couldn't be parsed — repeats the question. */
export function clarifyRetry(lang: Lang, question: string): string {
  switch (lang) {
    case "ur":
      return `سمجھ نہیں آیا — دوبارہ کوشش کریں:\n${question}`;
    case "en":
      return `Didn't quite get that — try again:\n${question}`;
    case "roman":
    default:
      return `Samajh nahi aaya — dobara try karein:\n${question}`;
  }
}

// ---------------------------------------------------------------------------
// NEEDS_INFO question templates (deterministic; typed fallback for desktop)
// ---------------------------------------------------------------------------

export interface QuestionSpec {
  field: string;
  question: string;
  quickReplies?: QuickReply[];
}

function qr(title: string, field: string, value: string): QuickReply {
  if (title.length > 20) throw new Error(`Quick reply title too long (${title.length}): ${title}`);
  return { title, payload: `info:${field}:${value}` };
}

export function questionForField(field: string, lang: Lang, photosHave = 0): QuestionSpec {
  const L = (ro: string, u: string, en: string) => (lang === "ur" ? u : lang === "en" ? en : ro);
  switch (field) {
    case "photos": {
      const need = Math.max(1, 2 - photosHave);
      return {
        field,
        question: L(
          `📸 ${need} aur clear photo${need > 1 ? "s" : ""} chahiye — full item nazar aana chahiye. Bhej dein!`,
          `📸 ${need} مزید صاف تصاویر چاہیے — پوری آئٹم نظر آنی چاہیے۔ بھیج دیں!`,
          `📸 I need ${need} more clear photo${need > 1 ? "s" : ""} — the full item should be visible. Please send!`,
        ),
      };
    }
    case "category":
      return {
        field,
        question: L(
          "Yeh kya item hai? 👇\nYa likh dein, misal: kurti / dress / abaya / shirt / jeans / shoes / bag",
          "یہ کیا آئٹم ہے؟ 👇\nیا لکھ دیں، مثال: kurti / dress / abaya",
          "What kind of item is this? 👇\nOr type it, e.g. kurti / dress / abaya / shirt / jeans / shoes / bag",
        ),
        quickReplies: ["kurti", "dress", "abaya", "shirt", "jeans", "shoes", "bag"].map((c) =>
          qr(c[0]!.toUpperCase() + c.slice(1), "category", c),
        ),
      };
    case "condition":
      return {
        field,
        question: L(
          "Condition kya hai? 👇\nYa likh dein: new / like-new / good / fair",
          "کنڈیشن کیا ہے؟ 👇\nیا لکھ دیں: new / like-new / good / fair",
          "What's the condition? 👇\nOr type: new / like-new / good / fair",
        ),
        quickReplies: [
          qr(L("Brand new", "بالکل نیا", "Brand new"), "condition", "new"),
          qr(L("Like new", "نیا جیسا", "Like new"), "condition", "like_new"),
          qr(L("Good", "اچھی", "Good"), "condition", "good"),
          qr(L("Fair", "اوسط", "Fair"), "condition", "fair"),
        ],
      };
    case "gender":
      return {
        field,
        question: L("Yeh kis ke liye hai? 👇", "یہ کس کے لیے ہے؟ 👇", "Who is this for? 👇"),
        quickReplies: [
          qr(L("Women", "خواتین", "Women"), "gender", "women"),
          qr(L("Men", "مرد", "Men"), "gender", "men"),
          qr(L("Unisex", "یونیسیکس", "Unisex"), "gender", "unisex"),
        ],
      };
    case "size":
      return {
        field,
        question: L(
          "Size kya hai? (misal: S / M / L / XL / 38)",
          "سائز کیا ہے؟ (مثال: S / M / L / XL / 38)",
          "What's the size? (e.g. S / M / L / XL / 38)",
        ),
      };
    case "price_pkr":
      return {
        field,
        question: L(
          "Price kya rakhen? 💰 (PKR me sirf number likh dein, misal: 1500)",
          "قیمت کیا رکھیں؟ 💰 (PKR میں صرف نمبر لکھیں، مثال: 1500)",
          "What price should we set? 💰 (just the number in PKR, e.g. 1500)",
        ),
      };
    case "city":
      return {
        field,
        question: L(
          "Aap kis city se hain? 📍 (misal: Karachi / Lahore / Islamabad)",
          "آپ کس شہر سے ہیں؟ 📍 (مثال: Karachi / Lahore)",
          "Which city are you in? 📍 (e.g. Karachi / Lahore / Islamabad)",
        ),
      };
    case "caption":
      return {
        field,
        question: L(
          "Naya caption likh dein ✏️ (jo post par lagega)",
          "نیا کیپشن لکھ دیں ✏️",
          "Type the new caption ✏️ (this will go on the post)",
        ),
      };
    default:
      return {
        field,
        question: L(
          `Aur ek detail chahiye: ${field} — likh dein?`,
          `ایک اور تفصیل چاہیے: ${field} — لکھ دیں؟`,
          `One more detail needed: ${field} — please type it.`,
        ),
      };
  }
}
