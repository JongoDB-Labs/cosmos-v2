import {
  LayoutDashboard,
  FolderKanban,
  ListChecks,
  FileText,
  Video,
  Users,
  Building2,
  Wallet,
  BarChart3,
  Clock,
  type LucideIcon,
} from "lucide-react";

/**
 * Customizable mobile bottom-nav.
 *
 * Chat is FIXED in the center slot and is not part of this list. The four slots
 * around it (two left, two right) are user-choosable from Settings → Preferences
 * → Mobile Navigation. The choice is stored in localStorage (a nav layout is
 * reasonably per-device — phone vs tablet may differ) and read by both the nav
 * and the preferences UI. Changing it dispatches MOBILE_NAV_CHANGED_EVENT so an
 * already-mounted nav re-reads without a reload.
 */
export interface MobileNavDest {
  key: string;
  label: string;
  /** Suffix appended to `/${orgSlug}` ("" = the org overview root). */
  href: string;
  icon: LucideIcon;
}

export const MOBILE_NAV_DESTINATIONS: MobileNavDest[] = [
  { key: "overview", label: "Overview", href: "", icon: LayoutDashboard },
  { key: "projects", label: "Projects", href: "/projects", icon: FolderKanban },
  { key: "issues", label: "Issues", href: "/issues", icon: ListChecks },
  { key: "notes", label: "Notes", href: "/notes", icon: FileText },
  { key: "meetings", label: "Meetings", href: "/meetings", icon: Video },
  { key: "team", label: "Team", href: "/team", icon: Users },
  { key: "crm", label: "CRM", href: "/crm", icon: Building2 },
  { key: "finance", label: "Finance", href: "/finance", icon: Wallet },
  { key: "analytics", label: "Analytics", href: "/analytics", icon: BarChart3 },
  { key: "time", label: "Time Tracking", href: "/time-tracking", icon: Clock },
];

/** Default four slots (the historical Overview · Projects · [Chat] · Notes · Meetings). */
export const DEFAULT_MOBILE_NAV = ["overview", "projects", "notes", "meetings"];

const STORAGE_KEY = "cosmos:mobile-nav";
export const MOBILE_NAV_CHANGED_EVENT = "cosmos:mobile-nav:changed";

export function destForKey(key: string): MobileNavDest | undefined {
  return MOBILE_NAV_DESTINATIONS.find((d) => d.key === key);
}

/** The four chosen slot keys, validated; falls back to the default. */
export function loadMobileNav(): string[] {
  if (typeof window === "undefined") return DEFAULT_MOBILE_NAV;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_MOBILE_NAV;
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return DEFAULT_MOBILE_NAV;
    const valid = arr.filter(
      (k): k is string => typeof k === "string" && !!destForKey(k),
    );
    // Require exactly four distinct slots; otherwise fall back to a safe default.
    const distinct = [...new Set(valid)];
    return distinct.length === 4 ? distinct : DEFAULT_MOBILE_NAV;
  } catch {
    return DEFAULT_MOBILE_NAV;
  }
}

export function saveMobileNav(keys: string[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
  window.dispatchEvent(new CustomEvent(MOBILE_NAV_CHANGED_EVENT));
}
