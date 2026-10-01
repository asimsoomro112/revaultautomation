import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

describe("security rules", () => {
  it("firestore.rules exists and gates on the admin custom claim", () => {
    const p = join(ROOT, "firestore.rules");
    expect(existsSync(p)).toBe(true);
    const src = readFileSync(p, "utf8");
    expect(src).toContain("rules_version = '2'");
    expect(src).toContain("request.auth.token.admin == true");
    // No open read/write anywhere.
    expect(src).not.toMatch(/allow\s+read,\s*write:\s*if\s+true/);
  });

  it("storage.rules does NOT exist — photo storage moved to Cloudinary (2026-10-01); only firestore.rules is deployed", () => {
    const p = join(ROOT, "storage.rules");
    expect(existsSync(p)).toBe(false);
  });
});
