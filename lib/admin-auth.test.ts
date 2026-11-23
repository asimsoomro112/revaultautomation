import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authorizeAdmin } from "./admin-auth";
import { resetEnvCache } from "./env";

describe("authorizeAdmin", () => {
  beforeEach(() => {
    process.env.ADMIN_EMAILS = "boss@gmail.com, other@example.com";
    resetEnvCache();
  });
  afterEach(() => {
    delete process.env.ADMIN_EMAILS;
    resetEnvCache();
  });

  const okClaim = async () => ({ uid: "u1", email: "someone@gmail.com", admin: true });
  const noClaim = async () => ({ uid: "u2", email: "boss@gmail.com" });
  const stranger = async () => ({ uid: "u3", email: "stranger@gmail.com" });
  const badToken = async () => {
    throw new Error("token expired");
  };

  it("401 when the Authorization header is missing", async () => {
    const r = await authorizeAdmin(null, okClaim);
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it("401 when the token is invalid", async () => {
    const r = await authorizeAdmin("Bearer xyz", badToken);
    expect(r).toMatchObject({ ok: false, status: 401 });
  });

  it("grants via custom claim admin===true", async () => {
    const r = await authorizeAdmin("Bearer tok", okClaim);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) {
      expect(r.principal.via).toBe("claim");
      expect(r.principal.uid).toBe("u1");
    }
  });

  it("grants via ADMIN_EMAILS allowlist (bootstrap path)", async () => {
    const r = await authorizeAdmin("Bearer tok", noClaim);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) {
      expect(r.principal.via).toBe("allowlist");
      expect(r.principal.email).toBe("boss@gmail.com");
    }
  });

  it("allowlist match is case-insensitive", async () => {
    const r = await authorizeAdmin("Bearer tok", async () => ({
      uid: "u4",
      email: "BOSS@GMAIL.COM",
    }));
    expect(r.ok).toBe(true);
  });

  it("403 when the token is valid but the user is not an admin", async () => {
    const r = await authorizeAdmin("Bearer tok", stranger);
    expect(r).toMatchObject({ ok: false, status: 403, error: expect.stringContaining("Access denied") });
  });
});
