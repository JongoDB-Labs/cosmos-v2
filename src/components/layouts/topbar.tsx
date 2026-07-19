"use client";

import { Button } from "@/components/ui/button";
import { Menu, Search, MessageSquarePlus, Sparkles } from "lucide-react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Breadcrumbs } from "./breadcrumbs";
import { NotificationDropdown } from "@/components/notifications/notification-dropdown";
import { usePermissions } from "@/components/providers/permissions-provider";
import { visibleTopbarNav } from "./topbar-nav";
import { isHrefActive, resolveHref } from "./nav-active";
import { useTotalUnread } from "@/hooks/use-total-unread";
import {
  useDrawers,
  type DrawerTool,
} from "@/components/drawers/drawer-provider";

// Topbar tabs whose destination is now a DOCKED DRAWER (opened in place) rather
// than a full page. Team has no drawer, so it stays a normal page link.
const DRAWER_TABS: Record<string, DrawerTool> = {
  chat: "chat",
  meetings: "meetings",
  notes: "notes",
};

interface TopbarProps {
  orgs: {
    id: string;
    slug: string;
    name: string;
  }[];
  onToggleSidebar: () => void;
  /** Whether the sidebar is currently expanded — drives the toggle's
      accessible name so screen readers announce the action AND the state
      ("Collapse sidebar" when open, "Expand sidebar" when collapsed). */
  sidebarExpanded: boolean;
}

export function Topbar({ orgs, onToggleSidebar, sidebarExpanded }: TopbarProps) {
  const pathname = usePathname();
  // Effective org slug from a MATCHED membership (undefined on /onboarding,
  // /admin, …) so resolveHref() falls back to NO_MATCH and nothing highlights.
  const currentOrg = orgs.find((o) => o.slug === pathname.split("/")[1]);
  const orgSlug = currentOrg?.slug;
  const { can } = usePermissions();
  const { openDrawer, isOpen } = useDrawers();

  // useTotalUnread must run unconditionally to keep hook order stable; empty
  // orgId is a no-op inside the hook.
  const totalUnread = useTotalUnread(currentOrg?.id ?? "");

  const tabItems = visibleTopbarNav(can);

  return (
    <header className="flex h-14 items-center justify-between border-b border-[var(--border)] bg-[var(--bg)] px-4">
      <div className="flex min-w-0 items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onToggleSidebar}
          aria-label={sidebarExpanded ? "Collapse sidebar" : "Expand sidebar"}
        >
          <Menu className="h-4 w-4" />
        </Button>
        <Breadcrumbs orgs={orgs} />
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {/* Moved nav: Notes, Chat, Team, Meetings as icon/tab links (item 7).
            These are PRIMARY destinations that live only in the topbar — the
            sidebar has none of them. (Mobile reaches them via the drawer.) */}
        {currentOrg && (
          <nav
            aria-label="Workspace sections"
            className="mr-1 hidden items-center gap-0.5 md:flex"
          >
            {tabItems.map((item) => {
              const Icon = item.icon;
              const showBadge = item.unreadBadge && totalUnread > 0;
              const drawerTool = DRAWER_TABS[item.id];
              const badge = showBadge && (
                <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-1 text-[8px] font-bold text-destructive-foreground">
                  {totalUnread > 9 ? "9+" : totalUnread}
                </span>
              );

              // Drawer-backed tabs (Chat / Meetings / Notes) open in place; the
              // active state tracks the open drawer, not the route.
              if (drawerTool) {
                const active = isOpen(drawerTool);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => openDrawer(drawerTool)}
                    aria-pressed={active}
                    title={item.label}
                    className={cn(
                      "relative flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                      active
                        ? "bg-[var(--primary-tint)] text-[var(--primary)]"
                        : "text-[var(--text-muted)] hover:bg-[var(--primary-tint)] hover:text-[var(--text)]",
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="hidden lg:inline">{item.label}</span>
                    {badge}
                  </button>
                );
              }

              // Page-backed tabs (Team) stay normal links.
              const href = resolveHref(orgSlug, item.href);
              const active = isHrefActive(pathname, href, false);
              return (
                <Link
                  key={item.id}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  title={item.label}
                  className={cn(
                    "relative flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                    active
                      ? "bg-[var(--primary-tint)] text-[var(--primary)]"
                      : "text-[var(--text-muted)] hover:bg-[var(--primary-tint)] hover:text-[var(--text)]",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="hidden lg:inline">{item.label}</span>
                  {badge}
                </Link>
              );
            })}
          </nav>
        )}

        <Button
          variant="ghost"
          size="sm"
          className="hidden gap-2 text-[var(--text-muted)] md:flex"
          onClick={() => {
            window.dispatchEvent(new CustomEvent("cosmos:command-palette:open"));
          }}
        >
          <Search className="h-3.5 w-3.5" />
          <span className="text-xs">Search</span>
          <kbd className="ml-2 rounded border border-[var(--border)] px-1 text-[10px]">
            ⌘K
          </kbd>
        </Button>

        {/* Global drawer triggers (item 8): Assistant, Notes, Feedback open a
            right-side slide-over that OVERLAYS the current screen, so the user
            keeps their work in view. Feedback was previously a link to a route;
            it now opens the in-place drawer. */}
        {currentOrg && (
          <div className="flex items-center gap-0.5">
            {/* Mobile-only search trigger: the full Search button above is md+
                only and ⌘K needs a hardware keyboard, so without this phones
                have no way to open the command palette / search. */}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-[var(--text-muted)] hover:text-[var(--text)] md:hidden"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("cosmos:command-palette:open"),
                )
              }
              aria-label="Search"
              title="Search"
            >
              <Search className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-[var(--text-muted)] hover:text-[var(--text)]"
              onClick={() => openDrawer("assistant")}
              aria-label="Open assistant"
              title="Assistant"
            >
              <Sparkles className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-[var(--text-muted)] hover:text-[var(--text)]"
              onClick={() => openDrawer("feedback")}
              aria-label="Send feedback"
              title="Feedback"
            >
              <MessageSquarePlus className="h-4 w-4" />
            </Button>
          </div>
        )}

        {currentOrg && <NotificationDropdown orgId={currentOrg.id} />}
      </div>
    </header>
  );
}
