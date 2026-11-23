/**
 * Admin navigation — one route per section.
 *
 * Single source of truth for the bottom bar (mobile), the top bar
 * (desktop) and the dashboard home cards. Labels, hrefs and blurbs live
 * here so a rename touches one file, not three components.
 */
export type NavIconKey =
  | "stats"
  | "queue"
  | "quota"
  | "token"
  | "kill"
  | "log"
  | "settings"
  | "activity"
  | "banned";

export interface NavLink {
  href: string;
  label: string;
  icon: NavIconKey;
  blurb: string;
}

export const NAV_LINKS: NavLink[] = [
  {
    href: "/admin",
    label: "Stats",
    icon: "stats",
    blurb: "Today, this week, and what needs review.",
  },
  {
    href: "/admin/queue",
    label: "Queue",
    icon: "queue",
    blurb: "Listings waiting for review, approval, or a fix.",
  },
  {
    href: "/admin/quota",
    label: "Quota",
    icon: "quota",
    blurb: "Instagram API usage against the daily limit.",
  },
  {
    href: "/admin/token",
    label: "Token",
    icon: "token",
    blurb: "Bot token health and expiry.",
  },
  {
    href: "/admin/kill",
    label: "Kill switch",
    icon: "kill",
    blurb: "Stop all publishing instantly.",
  },
  {
    href: "/admin/log",
    label: "Log",
    icon: "log",
    blurb: "Every publish attempt and its result.",
  },
  {
    href: "/admin/settings",
    label: "Settings",
    icon: "settings",
    blurb: "Publish mode, limits, and posting window.",
  },
  {
    href: "/admin/activity",
    label: "Activity",
    icon: "activity",
    blurb: "Latest listing events, newest first.",
  },
  {
    href: "/admin/banned",
    label: "Banned",
    icon: "banned",
    blurb: "Blocked sellers and unban.",
  },
];

/** Look up one page's nav entry by its route; undefined for unknown routes. */
export function navLinkFor(href: string): NavLink | undefined {
  return NAV_LINKS.find((l) => l.href === href);
}
