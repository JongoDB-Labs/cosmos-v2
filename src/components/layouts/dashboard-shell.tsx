"use client";

import { useRef, useState } from "react";
import { useMediaQuery } from "@/lib/hooks/use-media-query";
import {
  useHashAnchorScroll,
  useMainScrollRestorer,
} from "@/lib/hooks/use-main-scroll";
import { usePathname } from "next/navigation";
import { AppSidebar } from "./app-sidebar";
import { Topbar } from "./topbar";
import { MobileBottomNav } from "./mobile-bottom-nav";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { WakeWordProvider } from "@/components/wake-word/wake-word-provider";

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
  children: React.ReactNode;
}

export function DashboardShell({ user, orgs, children }: DashboardShellProps) {
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [sidebarOpen, setSidebarOpen] = useState(!isMobile);
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();
  const orgSlug = pathname.split("/")[1];
  const currentOrgId = orgs.find((o) => o.slug === orgSlug)?.id;
  const mainRef = useRef<HTMLElement>(null);

  useMainScrollRestorer(mainRef);
  useHashAnchorScroll(mainRef);

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--bg)] dark:bg-transparent">
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
          className="flex-1 overflow-y-auto overflow-x-hidden pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0"
        >
          {children}
        </main>
      </div>

      <MobileBottomNav orgSlug={orgSlug} orgId={currentOrgId} />
    </div>
  );
}
