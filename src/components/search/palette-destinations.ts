import { MessageSquarePlus, type LucideIcon } from "lucide-react";
import type { DrawerTool } from "@/components/drawers/drawer-provider";
import {
  visibleSidebarNav,
  type SidebarOrgSettings,
} from "@/components/layouts/nav-plugins";
import { visibleTopbarNav } from "@/components/layouts/topbar-nav";
import {
  SETTINGS_NAV_GROUPS,
  canViewSettings,
} from "@/lib/rbac/settings-access";

/**
 * One place the ⌘K palette jumps to: a page (org-relative `href`, "" is the
 * org overview) or a docked drawer (Chat has no page, only its drawer).
 */
export type PaletteDestination = {
  key: string;
  label: string;
  group: "goto" | "settings";
  icon: LucideIcon;
} & ({ href: string; drawer?: undefined } | { href?: undefined; drawer: DrawerTool });

/**
 * Every page the palette offers, built from the same lists and filters the
 * sidebar, the topbar and the Settings menu use. A page appears here exactly
 * when the person would see it in one of those menus, so the palette can't
 * fall behind them or offer a page that only shows a no-access screen.
 *
 * Without a current org (/admin, /onboarding) there is nothing to jump to, and
 * the permissions there are only a VIEWER fallback, so the list is empty.
 */
export function paletteDestinations({
  can,
  permissions,
  org,
}: {
  can: (p: bigint) => boolean;
  permissions: bigint;
  org: SidebarOrgSettings | undefined;
}): PaletteDestination[] {
  if (!org) return [];

  const out: PaletteDestination[] = [];

  for (const entry of visibleSidebarNav(can, org)) {
    if (entry.type === "leaf") {
      out.push({
        key: `goto:${entry.href}`,
        label: entry.label,
        group: "goto",
        icon: entry.icon,
        href: entry.href,
      });
    } else {
      for (const leaf of entry.children) {
        out.push({
          key: `goto:${leaf.href}`,
          label: `${entry.label} › ${leaf.label}`,
          group: "goto",
          icon: leaf.icon,
          href: leaf.href,
        });
      }
    }
  }

  for (const item of visibleTopbarNav(can)) {
    // Meetings and Notes have pages, so the palette goes there (as it always
    // has); Chat has only its drawer.
    if (item.href !== undefined) {
      out.push({ key: `goto:${item.href}`, label: item.label, group: "goto", icon: item.icon, href: item.href });
    } else if (item.drawer !== undefined) {
      out.push({ key: `goto:${item.drawer}`, label: item.label, group: "goto", icon: item.icon, drawer: item.drawer });
    }
  }

  out.push({ key: "goto:/feedback", label: "Feedback", group: "goto", icon: MessageSquarePlus, href: "/feedback" });

  for (const group of SETTINGS_NAV_GROUPS) {
    for (const item of group.items) {
      if (!canViewSettings({ permissions }, item.href)) continue;
      out.push({
        key: `settings:${item.href}`,
        label: `Settings › ${item.label}`,
        group: "settings",
        icon: item.icon,
        href: item.href,
      });
    }
  }

  const seen = new Set<string>();
  return out.filter((d) => (seen.has(d.key) ? false : (seen.add(d.key), true)));
}

/**
 * Word-by-word match: every word typed must appear somewhere in the label,
 * ignoring case, so "settings api" finds "Settings › API Keys". An empty query
 * matches everything.
 */
export function matchesWords(label: string, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hay = label.toLowerCase();
  return words.every((w) => hay.includes(w));
}
