import {
  FileText,
  MessageSquare,
  Users,
  Video,
  type LucideIcon,
} from "lucide-react";
import { Permission } from "@/lib/rbac/permissions";
import type { DrawerTool } from "@/components/drawers/drawer-provider";

/**
 * Items that live in the TOPBAR (item 7): Notes, Chat, Team, Meetings.
 * Each is RBAC-gated; Team is always visible (membership management is a core
 * surface). Rendered as icon/tab links with active highlighting.
 *
 * An item with a `drawer` opens that docked drawer in place, in the topbar and
 * in the mobile sidebar alike, instead of following a link. Chat has a drawer
 * and NO page: its old page only redirects into the drawer now.
 */
interface TopbarNavBase {
  id: string;
  icon: LucideIcon;
  label: string;
  /** Visible when the user holds at least one of these. Omit = always visible. */
  anyOf?: bigint[];
  /** Show an unread badge driven by the chat unread count. */
  unreadBadge?: boolean;
}

export type TopbarNavItem = TopbarNavBase &
  (
    | { drawer?: undefined; href: string }
    | { drawer: DrawerTool; href?: string }
  );

export const TOPBAR_NAV: TopbarNavItem[] = [
  {
    id: "chat",
    icon: MessageSquare,
    label: "Chat",
    drawer: "chat",
    anyOf: [Permission.CHAT_USE],
    unreadBadge: true,
  },
  {
    id: "meetings",
    icon: Video,
    label: "Meetings",
    href: "/meetings",
    drawer: "meetings",
    anyOf: [Permission.MEETING_READ],
  },
  {
    id: "notes",
    icon: FileText,
    label: "Notes",
    href: "/notes",
    drawer: "notes",
    anyOf: [Permission.NOTE_READ],
  },
  {
    id: "team",
    icon: Users,
    label: "Org",
    href: "/team",
  },
];

/**
 * Filter the moved nav down to what the user may see. Shared by the topbar
 * (desktop) and the mobile drawer so these destinations are reachable on every
 * surface. An item with no `anyOf` is always visible.
 */
export function visibleTopbarNav(
  can: (p: bigint) => boolean,
): TopbarNavItem[] {
  return TOPBAR_NAV.filter(
    (item) => !item.anyOf || item.anyOf.some((p) => can(p)),
  );
}
