"use client";

import { useEffect, useRef, useState } from "react";
import { useMediaQuery } from "@/lib/hooks/use-media-query";
import {
  useHashAnchorScroll,
  useMainScrollRestorer,
} from "@/lib/hooks/use-main-scroll";
import { usePathname } from "next/navigation";
import { AppSidebar } from "./app-sidebar";
import { Topbar } from "./topbar";
import { MobileBottomNav } from "./mobile-bottom-nav";
import { FloatingAgentBubble } from "./floating-agent-bubble";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { WakeWordProvider } from "@/components/wake-word/wake-word-provider";
import { DrawerProvider } from "@/components/drawers/drawer-provider";
import { DockedDrawer } from "@/components/drawers/docked-drawer";

interface DashboardShellProps {
  user: {
    id: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
  };
  orgs: {
    id: string;
    name: string;
    slug: string;
    plan: string;
    logoUrl: string | null;
    role: string;
  }[];
  /** Platform/system admin (INTERNAL_ADMINS) — surfaces the System Admin menu. */
  isSystemAdmin?: boolean;
  children: React.ReactNode;
}

export function DashboardShell({ user, orgs, isSystemAdmin = false, children }: DashboardShellProps) {
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [sidebarOpen, setSidebarOpen] = useState(!isMobile);
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();
  const orgSlug = pathname.split("/")[1];
  const currentOrgId = orgs.find((o) => o.slug === orgSlug)?.id;
  const mainRef = useRef<HTMLElement>(null);

  useMainScrollRestorer(mainRef);
  useHashAnchorScroll(mainRef);

  // Lock the document/viewport scroller while the dashboard shell is mounted so
  // <main> is the ONLY scroll surface. Without this, a page whose content
  // overflows <main> (e.g. Settings, long lists) also leaves the *viewport*
  // scrollable in Chromium — a nested overflow:auto scroller propagates its
  // overflow to the documentElement even though every app-level ancestor
  // (h-screen root, body) is correctly clipped at 100vh. The visible symptom:
  // wheeling over the fixed topbar scrolls the whole page "into nothingness".
  // Scoped to the dashboard (this client shell) so login/marketing pages, which
  // legitimately rely on document scroll, are unaffected; cleanup restores the
  // prior value on unmount.
  useEffect(() => {
    const html = document.documentElement;
    const prevHtml = html.style.overflow;
    const prevBody = document.body.style.overflow;
    html.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    return () => {
      html.style.overflow = prevHtml;
      document.body.style.overflow = prevBody;
    };
  }, []);

  return (
    <DrawerProvider>
    {/* The whole shell reflows LEFT when a docked drawer is open: the
        right padding (published as --cosmos-drawer-w by DockedDrawer, 0 on
        mobile / when closed) opens a gap the fixed drawer fills, so the page
        stays fully visible and interactive beside it — no overlay, no blur. */}
    <div
      className="flex h-screen overflow-hidden bg-[var(--bg)] transition-[padding] duration-200 ease-out dark:bg-transparent"
      style={{ paddingRight: "var(--cosmos-drawer-w, 0px)" }}
    >
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-[var(--primary)] focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white focus:shadow-lg"
      >
        Skip to content
      </a>
      <WakeWordProvider />
      {!isMobile && (
        <AppSidebar
          open={sidebarOpen}
          onToggle={() => setSidebarOpen(!sidebarOpen)}
          orgs={orgs}
          user={user}
          isSystemAdmin={isSystemAdmin}
        />
      )}

      {isMobile && (
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          {/* showCloseButton={false}: the AppSidebar's own collapse control
              (wired to close the drawer on mobile) is the single close
              affordance — the Sheet's built-in X would be a duplicate. */}
          <SheetContent side="left" className="w-72 p-0" showCloseButton={false}>
            <AppSidebar
              open={true}
              onToggle={() => setMobileOpen(false)}
              orgs={orgs}
              user={user}
              isSystemAdmin={isSystemAdmin}
              // Surface the topbar-only destinations (Notes/Chat/Team/Meetings +
              // Feedback) in the drawer — on mobile the topbar nav is hidden, so
              // this is the only place they're reachable (item 2).
              showMovedNav
            />
          </SheetContent>
        </Sheet>
      )}

      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar
          orgs={orgs}
          onToggleSidebar={() =>
            isMobile ? setMobileOpen(!mobileOpen) : setSidebarOpen(!sidebarOpen)
          }
        />
        <main
          ref={mainRef}
          id="main"
          // min-h-0 is REQUIRED: as a flex-1 child its default min-height:auto
          // makes it grow to content height, so the overflow-hidden column clips
          // tall pages instead of letting main scroll. min-h-0 lets it shrink to
          // the flex-allocated height so overflow-y-auto actually scrolls.
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0"
        >
          {children}
        </main>
      </div>

      <MobileBottomNav orgSlug={orgSlug} orgId={currentOrgId} />

      {/* Persistent COSMOS Agent overlay (item 9). */}
      <FloatingAgentBubble orgId={currentOrgId} />

      {/* The single NON-MODAL docked drawer (Assistant / Chat / Notes /
          Meetings / Feedback), opened from the topbar. It docks on the right
          and the shell reflows beside it (see paddingRight above) — no
          backdrop, no blur, page stays interactive for true multitasking. */}
      <DockedDrawer orgId={currentOrgId} orgSlug={orgSlug} userId={user.id} />
    </div>
    </DrawerProvider>
  );
}
