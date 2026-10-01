/**
 * Firebase client SDK for /admin (browser only).
 * Config comes from NEXT_PUBLIC_FIREBASE_* env vars (public web config —
 * safe to expose; auth is enforced server-side by ID token verification).
 */
import { getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";

export function getClientConfigError(): string | null {
  const missing: string[] = [];
  if (!process.env.NEXT_PUBLIC_FIREBASE_API_KEY) missing.push("NEXT_PUBLIC_FIREBASE_API_KEY");
  if (!process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN)
    missing.push("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN");
  if (!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID)
    missing.push("NEXT_PUBLIC_FIREBASE_PROJECT_ID");
  return missing.length > 0 ? `Missing env: ${missing.join(", ")}` : null;
}

let app: FirebaseApp | null = null;

export function getClientApp(): FirebaseApp {
  if (app) return app;
  const existing = getApps();
  if (existing.length > 0 && existing[0]) {
    app = existing[0];
    return app;
  }
  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  const authDomain = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN;
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (!apiKey || !authDomain || !projectId) {
    throw new Error(
      "Firebase client config missing: set NEXT_PUBLIC_FIREBASE_API_KEY, " +
        "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN and NEXT_PUBLIC_FIREBASE_PROJECT_ID",
    );
  }
  app = initializeApp({ apiKey, authDomain, projectId });
  return app;
}

export function getClientAuth(): Auth {
  return getAuth(getClientApp());
}
