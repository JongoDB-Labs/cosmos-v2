import {
  FileText,
  MessageSquare,
  Users,
  Video,
  type LucideIcon,
} from "lucide-react";
import { Permission } from "@/lib/rbac/permissions";

/**
 * Items that live in the TOPBAR (item 7): Notes, Chat, Team, Meetings.
 * Each is RBAC-gated; Team is always visible (membership management is a core
 * surface). Rendered as icon/tab links with active highlighting.
 */
export interface TopbarNavItem {
  id: string;
  icon: LucideIcon;
  label: string;
  href: string;
  /** Visible when the user holds at least one of these. Omit = always visible. */
  anyOf?: bigint[];
  /** Show an unread badge driven by the chat unread count. */
  unreadBadge?: boolean;
}

export const TOPBAR_NAV: TopbarNavItem[] = [
  {
    id: "chat",
    icon: MessageSquare,
    label: "Chat",
    href: "/chat",
    anyOf: [Permission.CHAT_USE],
    unreadBadge: true,
  },
  {
    id: "meetings",
    icon: Video,
    label: "Meetings",
    href: "/meetings",
    anyOf: [Permission.MEETING_READ],
  },
  {
    id: "notes",
    icon: FileText,
    label: "Notes",
    href: "/notes",
    anyOf: [Permission.NOTE_READ],
  },
  {
    id: "team",
    icon: Users,
    label: "Team",
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
