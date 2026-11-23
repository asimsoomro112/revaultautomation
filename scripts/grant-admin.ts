/**
 * One-time admin bootstrap: set custom claim { admin: true } on Firebase users.
 *
 * Usage:  npm run grant-admin -- you@gmail.com [other@gmail.com ...]
 *
 * Looks each email up via Admin SDK (getUserByEmail) and sets the claim.
 * The claim propagates to the user's ID token on next issuance — the user
 * must sign out/in (or wait up to 1h for token rotation) before /admin
 * grants access via the claim path. Until then the ADMIN_EMAILS allowlist
 * fallback keeps /admin reachable.
 */
import { adminAuth, getAdminApp } from "../lib/firebase-admin";

async function main(): Promise<void> {
  const emails = process.argv.slice(2).filter(Boolean);
  if (emails.length === 0) {
    console.error("Usage: npm run grant-admin -- <email> [email ...]");
    process.exit(1);
  }
  getAdminApp(); // validates Firebase env early with a clear error
  const auth = adminAuth();

  let failed = 0;
  for (const email of emails) {
    try {
      const user = await auth.getUserByEmail(email);
      await auth.setCustomUserClaims(user.uid, { admin: true });
      console.log(`OK   ${email} (uid ${user.uid}) → custom claim { admin: true }`);
    } catch (err) {
      failed += 1;
      console.error(`FAIL ${email}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failed > 0) {
    console.error(`${failed} of ${emails.length} failed`);
    process.exit(2);
  }
  console.log(
    "Done. Affected users must sign out and back in (or wait ≤1h) for the claim to reach their ID token.",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
