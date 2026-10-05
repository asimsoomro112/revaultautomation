import type { Metadata } from "next";
import type { CSSProperties } from "react";

export const metadata: Metadata = {
  title: "Privacy Policy — ReVault DM-to-Post Bot",
  description:
    "Privacy policy for the ReVault DM-to-Post bot, the Instagram automation behind @therevaultofficial.",
};

const section: CSSProperties = { marginBottom: 28 };
const h2: CSSProperties = {
  fontSize: 20,
  marginBottom: 8,
  color: "#f2f5f9",
};
const p: CSSProperties = {
  fontSize: 15,
  lineHeight: 1.7,
  color: "#c3cbd6",
  margin: "0 0 12px",
};
const li: CSSProperties = {
  fontSize: 15,
  lineHeight: 1.7,
  color: "#c3cbd6",
  marginBottom: 6,
};

export default function PrivacyPage() {
  return (
    <main
      style={{
        maxWidth: 760,
        margin: "0 auto",
        padding: "48px 24px 80px",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
      }}
    >
      <h1 style={{ fontSize: 30, color: "#f2f5f9", marginBottom: 4 }}>
        Privacy Policy — ReVault DM-to-Post Bot
      </h1>
      <p style={{ ...p, color: "#8b94a1", fontSize: 14 }}>
        Effective date: October 4, 2026
      </p>

      <div style={section}>
        <h2 style={h2}>1. What this service is</h2>
        <p style={p}>
          The ReVault DM-to-Post Bot (&ldquo;ReVault&rdquo;, &ldquo;we&rdquo;)
          is an automation service for the Instagram professional account{" "}
          <strong>@therevaultofficial</strong>, a preloved-clothing
          marketplace. Sellers send item photos and details via Instagram
          Direct Messages; the bot organizes those submissions into listings
          for review and, after human approval, publishes them as posts on the
          page.
        </p>
      </div>

      <div style={section}>
        <h2 style={h2}>2. Data we collect</h2>
        <p style={p}>
          When you interact with @therevaultofficial over Instagram Direct,
          Meta shares the following with our app through the official
          Instagram APIs:
        </p>
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          <li style={li}>
            Message content you send (text and conversation context needed to
            build a listing).
          </li>
          <li style={li}>
            Photos you send as listing submissions, including image metadata.
          </li>
          <li style={li}>
            Your Instagram-scoped sender identifier (used only to route
            replies within the 24-hour messaging window).
          </li>
        </ul>
        <p style={p}>
          We do not collect your password, phone number, email address, or
          precise location, and we do not request access to anything beyond
          what you send us in Direct Messages.
        </p>
      </div>

      <div style={section}>
        <h2 style={h2}>3. How we use your data</h2>
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          <li style={li}>
            To assemble draft listings from your photos and details and show
            them to a human reviewer in a private admin dashboard.
          </li>
          <li style={li}>
            To reply to you in Direct Messages about your submission (only
            within Meta&rsquo;s permitted messaging window).
          </li>
          <li style={li}>
            To run automated quality and safety checks (for example,
            detecting duplicate or prohibited items) before anything is
            published.
          </li>
        </ul>
        <p style={p}>
          Listings are published to the public @therevaultofficial page only
          after explicit human approval. Nothing is posted automatically
          without review.
        </p>
      </div>

      <div style={section}>
        <h2 style={h2}>4. How your data is stored and protected</h2>
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          <li style={li}>
            <strong>Photos</strong> are copied immediately from temporary
            Instagram delivery links into private cloud storage (Cloudinary),
            marked private, and served only through short-lived signed URLs
            (about 4 hours). Temporary links are never stored.
          </li>
          <li style={li}>
            <strong>Messages and listing records</strong> are stored in a
            private database (Google Firestore) protected by deny-by-default
            access rules; only the verified page administrator can open the
            dashboard (Google sign-in plus an admin claim).
          </li>
          <li style={li}>
            <strong>Access tokens</strong> for the Instagram API are encrypted
            at rest (AES-256-GCM) and never logged or exposed.
          </li>
          <li style={li}>
            Phone numbers, email addresses, and street addresses are redacted
            at the logging boundary and never written to logs.
          </li>
        </ul>
      </div>

      <div style={section}>
        <h2 style={h2}>5. Data sharing</h2>
        <p style={p}>
          We share data only with the service providers required to operate
          the bot, each acting under its own privacy terms:
        </p>
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          <li style={li}>
            <strong>Meta Platforms</strong> — Instagram messaging and
            publishing APIs (the source of, and destination for, your DMs and
            published posts).
          </li>
          <li style={li}>
            <strong>Google</strong> — Firestore (database), Firebase
            Authentication (admin sign-in), and Gemini (AI-assisted
            extraction of listing details and safety moderation).
          </li>
          <li style={li}>
            <strong>Cloudinary</strong> — private image storage and delivery.
          </li>
          <li style={li}>
            <strong>Upstash (QStash)</strong> — reliable background job queue
            for webhook processing.
          </li>
        </ul>
        <p style={p}>
          We do not sell your personal data, and we do not share it with
          advertisers or data brokers.
        </p>
      </div>

      <div style={section}>
        <h2 style={h2}>6. Data retention</h2>
        <p style={p}>
          Listing records and their photos are kept while the marketplace
          listing is active and for a reasonable period afterwards for
          dispute handling and duplicate detection. If you ask us to delete
          your submission, we remove the stored photos and listing data
          associated with your messages. Backups, if any, expire on their
          normal cycle.
        </p>
      </div>

      <div style={section}>
        <h2 style={h2}>7. Your rights</h2>
        <p style={p}>
          You may request access to, correction of, or deletion of the
          personal data we hold about you by contacting us (see §9). We will
          respond within a reasonable time. You can also stop interacting
          with the bot at any time by simply not messaging the page.
        </p>
      </div>

      <div style={section}>
        <h2 style={h2}>8. Children</h2>
        <p style={p}>
          ReVault is not directed at children under 13, and we do not
          knowingly collect data from them.
        </p>
      </div>

      <div style={section}>
        <h2 style={h2}>9. Contact</h2>
        <p style={p}>
          For privacy questions or deletion requests, contact the page
          operator: <strong>muhammadasimxxx@gmail.com</strong>.
        </p>
      </div>

      <div style={section}>
        <h2 style={h2}>10. Changes to this policy</h2>
        <p style={p}>
          If we change this policy, we will update the effective date above
          and publish the new version at this URL.
        </p>
      </div>
    </main>
  );
}
