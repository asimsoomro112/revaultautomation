import { describe, expect, it } from "vitest";
import { NAV_LINKS, navLinkFor } from "../app/admin/components/navLinks";

/**
 * The nav table is the single source of truth for the bottom bar, the top
 * bar and the dashboard cards. If a route is renamed here and not in the
 * app router (or vice versa), a nav tap 404s — these tests pin the table
 * so the mismatch is caught in CI, not on Asim's phone.
 */
describe("admin nav links", () => {
  it("lists all nine admin pages", () => {
    expect(NAV_LINKS).toHaveLength(9);
    expect(NAV_LINKS[0]?.href).toBe("/admin");
  });

  it("every href is a distinct /admin route", () => {
    const hrefs = NAV_LINKS.map((l) => l.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const href of hrefs) {
      expect(href === "/admin" || href.startsWith("/admin/")).toBe(true);
    }
  });

  it("labels and blurbs are non-empty and unique", () => {
    const labels = NAV_LINKS.map((l) => l.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const l of NAV_LINKS) {
      expect(l.label.length).toBeGreaterThan(0);
      expect(l.blurb.length).toBeGreaterThan(0);
      expect(l.icon.length).toBeGreaterThan(0);
    }
  });

  it("navLinkFor resolves every href and misses unknown routes", () => {
    for (const l of NAV_LINKS) {
      expect(navLinkFor(l.href)).toBe(l);
    }
    expect(navLinkFor("/admin/nope")).toBeUndefined();
  });
});
