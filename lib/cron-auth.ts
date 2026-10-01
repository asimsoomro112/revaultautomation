/**
 * Vercel Cron authentication helper.
 *
 * Docs re-verified 2026-09-30: when CRON_SECRET is set in the Vercel project
 * env, Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` automatically
 * on every scheduled GET. We compare timing-safe and fail closed (401) when
 * the secret is missing or mismatched.
 */
import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { getEnv } from "./env";
import { log } from "./log";

export function isCronAuthorized(req: NextRequest): boolean {
  const secret = getEnv().CRON_SECRET;
  if (!secret) {
    log.error("cron-auth: CRON_SECRET not set — refusing cron request (fail closed)");
    return false;
  }
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
