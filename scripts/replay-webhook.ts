#!/usr/bin/env tsx
/**
 * Replay recorded Meta webhook fixtures against a running webhook endpoint.
 *
 *   tsx scripts/replay-webhook.ts --fixture text
 *   tsx scripts/replay-webhook.ts --fixture all --url http://localhost:3000/api/webhooks/instagram
 *   tsx scripts/replay-webhook.ts --verify   # GET verification handshake check
 *
 * Signs the RAW fixture bytes with IG_APP_SECRET (env, or the test default)
 * and POSTs with X-Hub-Signature-256 — exactly like Meta does.
 */
import { createHmac } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const TEST_SECRET = "test_app_secret_0123456789";
const TEST_VERIFY_TOKEN = "test_verify_token";

function argValue(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i === -1 || i + 1 >= process.argv.length) return def;
  return process.argv[i + 1];
}
function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

const baseUrl = argValue("--url", "http://localhost:3000/api/webhooks/instagram")!;
const fixtureArg = argValue("--fixture", "all")!;
const fixturesDir = path.join(__dirname, "..", "test", "fixtures", "webhooks");

async function listFixtures(): Promise<string[]> {
  if (fixtureArg === "all") {
    return (await readdir(fixturesDir)).filter((f) => f.endsWith(".json")).sort();
  }
  return [`${fixtureArg.replace(/\.json$/, "")}.json`];
}

async function postFixture(file: string): Promise<void> {
  const raw = await readFile(path.join(fixturesDir, file)); // raw bytes — never re-serialise
  const secret = process.env.IG_APP_SECRET ?? TEST_SECRET;
  const sig = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": sig,
    },
    body: raw,
  });
  const body = await res.text();
  console.log(`--- ${file}: HTTP ${res.status}`);
  console.log(body.slice(0, 500));
}

async function verifyHandshake(): Promise<void> {
  const params = new URLSearchParams({
    "hub.mode": argValue("--hub-mode", "subscribe")!,
    "hub.verify_token": argValue("--hub-verify-token", process.env.IG_VERIFY_TOKEN ?? TEST_VERIFY_TOKEN)!,
    "hub.challenge": argValue("--hub-challenge", "test-challenge-123")!,
  });
  const url = `${baseUrl}?${params.toString()}`;
  const res = await fetch(url);
  const body = await res.text();
  console.log(`GET ${url}\nHTTP ${res.status}\n${body.slice(0, 300)}`);
}

async function main(): Promise<void> {
  if (hasFlag("--verify")) {
    await verifyHandshake();
    return;
  }
  for (const file of await listFixtures()) {
    try {
      await postFixture(file);
    } catch (err) {
      console.error(`--- ${file}: FAILED`, err instanceof Error ? err.message : err);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
