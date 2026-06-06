"use client";

import { Button, buttonVariants } from "@/components/ui/button";
import { Menu, Search, Settings as SettingsIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Breadcrumbs } from "./breadcrumbs";
import { NotificationDropdown } from "@/components/notifications/notification-dropdown";

interface TopbarProps {
  orgs: {
    id: string;
    slug: string;
    name: string;
  }[];
  onToggleSidebar: () => void;
}

export function Topbar({ orgs, onToggleSidebar }: TopbarProps) {
  const pathname = usePathname();
  const orgSlug = pathname.split("/")[1];
  const currentOrg = orgs.find((o) => o.slug === orgSlug);

  return (
    <header className="flex h-14 items-center justify-between border-b border-[var(--border)] bg-[var(--bg)] px-4">
      <div className="flex items-center gap-3 min-w-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onToggleSidebar}
          aria-label="Toggle sidebar"
        >
          <Menu className="h-4 w-4" />
        </Button>
        <Breadcrumbs orgs={orgs} />
      </div>

      <div className="flex items-center gap-2">
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
        {currentOrg && <NotificationDropdown orgId={currentOrg.id} />}
        {currentOrg && (
          <Link
            href={`/${currentOrg.slug}/settings`}
            aria-label="Org settings"
            className={buttonVariants({ variant: "ghost", size: "icon" }) + " h-8 w-8"}
          >
            <SettingsIcon className="h-4 w-4" />
          </Link>
        )}
      </div>
    </header>
  );
}
