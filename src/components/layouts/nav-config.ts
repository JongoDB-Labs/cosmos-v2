import {
  LayoutDashboard,
  Settings,
  BarChart3,
  Clock,
  DollarSign,
  Briefcase,
  FolderKanban,
  ListChecks,
  Handshake,
  Package,
  FileSignature,
  Landmark,
  Receipt,
  Wallet,
  Percent,
  BookOpen,
  ClipboardList,
  type LucideIcon,
} from "lucide-react";
import { Permission } from "@/lib/rbac/permissions";

/**
 * Single source of truth for the sidebar information architecture.
 *
 * Every gated item declares the permission(s) that make it visible. An item
 * with `anyOf` is shown when the user holds AT LEAST ONE of the listed
 * permissions; an item with no permission is always visible (Overview,
 * Settings). Items the user can't access are removed from the tree entirely
 * (not disabled) — see app-sidebar.tsx.
 *
 * `href` is the org-relative path (the org slug is prefixed at render time).
 */

export interface NavLeaf {
  type: "leaf";
  /** Stable id used for admin reordering + active-state keys. */
  id: string;
  icon: LucideIcon;
  label: string;
  /** Org-relative path, e.g. "/projects". "" is the org overview root. */
  href: string;
  /** Visible only if the user holds at least one of these permissions. */
  anyOf?: bigint[];
}

export interface NavGroupDef {
  type: "group";
  id: string;
  icon: LucideIcon;
  label: string;
  children: NavLeaf[];
  /**
   * A group is shown when the user can see at least one child. This is derived,
   * not declared, so a group never out-grants its members.
   */
}

export type NavEntry = NavLeaf | NavGroupDef;

/**
 * Top-level sidebar IA. Notes / Chat / Team / Meetings live in the topbar, the
 * COSMOS Agent is a floating bubble, and Feedback is a topbar affordance — so
 * none of them appear here.
 */
export const SIDEBAR_NAV: NavEntry[] = [
  {
    type: "leaf",
    id: "overview",
    icon: LayoutDashboard,
    label: "Overview",
    href: "",
  },
  {
    type: "leaf",
    id: "projects",
    icon: FolderKanban,
    label: "Projects",
    href: "/projects",
    anyOf: [Permission.PROJECT_READ],
  },
  {
    type: "leaf",
    id: "issues",
    icon: ListChecks,
    label: "Issues",
    href: "/issues",
    anyOf: [Permission.ITEM_READ],
  },
  {
    type: "leaf",
    id: "time-tracking",
    icon: Clock,
    label: "Time Tracking",
    href: "/time-tracking",
    anyOf: [Permission.TIME_READ],
  },
  {
    type: "group",
    id: "crm",
    icon: Briefcase,
    label: "CRM",
    children: [
      {
        type: "leaf",
        id: "crm-contacts",
        icon: Briefcase,
        label: "Contacts",
        href: "/crm",
        anyOf: [Permission.CRM_READ],
      },
      {
        type: "leaf",
        id: "crm-partners",
        icon: Handshake,
        label: "Partners",
        href: "/partners",
        anyOf: [Permission.CRM_READ],
      },
      {
        type: "leaf",
        id: "crm-products",
        icon: Package,
        label: "Products",
        href: "/products",
        anyOf: [Permission.CRM_READ],
      },
      {
        type: "leaf",
        id: "crm-contracts",
        icon: FileSignature,
        label: "Contracts",
        href: "/contracts",
        anyOf: [Permission.CRM_READ],
      },
      {
        type: "leaf",
        id: "crm-invoices",
        icon: Receipt,
        label: "Invoices",
        href: "/finance/invoices",
        anyOf: [Permission.FINANCE_READ, Permission.ACCOUNTING_READ],
      },
    ],
  },
  {
    type: "group",
    id: "accounting",
    icon: BookOpen,
    label: "Accounting",
    children: [
      {
        type: "leaf",
        id: "acct-finance",
        icon: DollarSign,
        label: "Finance",
        href: "/finance",
        anyOf: [Permission.FINANCE_READ],
      },
      {
        type: "leaf",
        id: "acct-ledger",
        icon: BookOpen,
        label: "Accounting",
        href: "/finance/accounting",
        anyOf: [Permission.ACCOUNTING_READ, Permission.FINANCE_READ],
      },
      {
        type: "leaf",
        id: "acct-banking",
        icon: Landmark,
        label: "Banking",
        href: "/finance/banking",
        anyOf: [Permission.FINANCE_READ, Permission.ACCOUNTING_READ],
      },
      {
        type: "leaf",
        id: "acct-payroll",
        icon: Wallet,
        label: "Payroll",
        href: "/finance/payroll",
        anyOf: [Permission.FINANCE_READ, Permission.ACCOUNTING_READ],
      },
      {
        type: "leaf",
        id: "acct-tax",
        icon: Percent,
        label: "Tax",
        href: "/finance/tax",
        anyOf: [Permission.FINANCE_READ, Permission.ACCOUNTING_READ],
      },
    ],
  },
  {
    type: "leaf",
    id: "analytics",
    icon: BarChart3,
    label: "Analytics",
    href: "/analytics",
    anyOf: [Permission.ANALYTICS_READ],
  },
  {
    type: "leaf",
    id: "pm-dashboard",
    icon: ClipboardList,
    label: "PM Dashboard",
    href: "/pm-dashboard",
    anyOf: [Permission.ANALYTICS_READ, Permission.REPORT_CREATE],
  },
  {
    type: "leaf",
    id: "settings",
    icon: Settings,
    label: "Settings",
    href: "/settings",
  },
];

/**
 * Top-level entries surfaced to the admin nav-customization UI (item 12):
 * id + display label + whether it's a group. Overview and Settings are
 * intentionally NOT reorderable/hideable — they're the fixed anchors of the IA.
 */
export const FIXED_NAV_IDS = ["overview", "settings"] as const;

export function topLevelNavMeta(): { id: string; label: string; isGroup: boolean; fixed: boolean }[] {
  return SIDEBAR_NAV.map((e) => ({
    id: e.id,
    label: e.label,
    isGroup: e.type === "group",
    fixed: (FIXED_NAV_IDS as readonly string[]).includes(e.id),
  }));
}

/** True when the user (permission mask) may see this leaf. */
export function canSeeLeaf(leaf: NavLeaf, can: (p: bigint) => boolean): boolean {
  if (!leaf.anyOf || leaf.anyOf.length === 0) return true;
  return leaf.anyOf.some((p) => can(p));
}

/**
 * Filter the IA down to what the user may see. Groups with no visible children
 * are dropped. Returns leaves and groups (groups always carry >=1 child).
 */
export function visibleNav(
  entries: NavEntry[],
  can: (p: bigint) => boolean,
): NavEntry[] {
  const out: NavEntry[] = [];
  for (const entry of entries) {
    if (entry.type === "leaf") {
      if (canSeeLeaf(entry, can)) out.push(entry);
    } else {
      const kids = entry.children.filter((c) => canSeeLeaf(c, can));
      if (kids.length > 0) out.push({ ...entry, children: kids });
    }
  }
  return out;
}

/**
 * Apply an admin-defined order + visibility map (from Organization.settings)
 * to the top-level entries. Unknown ids in `order` are ignored; entries absent
 * from `order` keep their default position (appended in declaration order).
 * `hidden` ids are removed. Settings only constrain — they never reveal an
 * item the user lacks permission for (that filtering happens first).
 */
export function applyAdminLayout(
  entries: NavEntry[],
  cfg: { order?: string[]; hidden?: string[] } | undefined,
): NavEntry[] {
  if (!cfg) return entries;
  const hidden = new Set(cfg.hidden ?? []);
  const visible = entries.filter((e) => !hidden.has(e.id));
  if (!cfg.order || cfg.order.length === 0) return visible;
  const orderIndex = new Map(cfg.order.map((id, i) => [id, i]));
  return [...visible].sort((a, b) => {
    const ai = orderIndex.has(a.id) ? orderIndex.get(a.id)! : Number.MAX_SAFE_INTEGER;
    const bi = orderIndex.has(b.id) ? orderIndex.get(b.id)! : Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });
}

/**
 * Entitlement filter (Pontis foundation §3.2 enforcement): drop top-level entries
 * whose module is not enabled for the tenant. Module keys === top-level nav ids;
 * the FIXED anchors (overview, settings) are always kept. `enabledModules === null`
 * means "all modules enabled" (the default), so this is a no-op for existing tenants.
 */
export function applyEntitlements(
  entries: NavEntry[],
  enabledModules: string[] | null,
): NavEntry[] {
  if (enabledModules === null) return entries;
  const allowed = new Set(enabledModules);
  return entries.filter(
    (e) => (FIXED_NAV_IDS as readonly string[]).includes(e.id) || allowed.has(e.id),
  );
}
