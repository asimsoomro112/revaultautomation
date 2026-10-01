import { adminDb } from "../lib/firebase-admin";
import { getEnv } from "../lib/env";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

async function run() {
  console.log("--- Testing Publish Log ---");
  try {
    const snap = await adminDb()
      .collection("listings")
      .where("status", "==", "PUBLISHED")
      .orderBy("created_at", "desc")
      .limit(5)
      .get();
    console.log("Publish Log Success, got", snap.docs.length);
  } catch (err: any) {
    console.log("Publish Log Error:", err.message);
  }

  console.log("\n--- Testing Quota ---");
  try {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: getEnv().TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    console.log("Fetching doc:", `counters/daily_posts/${today}`);
    const counter = await adminDb().doc(`counters/daily_posts/${today}`).get();
    console.log("Quota Success");
  } catch (err: any) {
    console.log("Quota Error:", err.message);
  }
}

run().catch(console.error);
