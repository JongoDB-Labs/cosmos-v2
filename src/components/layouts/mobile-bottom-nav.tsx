"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessageCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTotalUnread } from "@/hooks/use-total-unread";
import { useDrawers } from "@/components/drawers/drawer-provider";
import {
  DEFAULT_MOBILE_NAV,
  MOBILE_NAV_CHANGED_EVENT,
  loadMobileNav,
  destForKey,
} from "@/lib/nav/mobile-nav";

// Chat is FIXED in the center; the four surrounding slots are user-customizable
// (Settings → Preferences → Mobile Navigation, persisted in localStorage). The
// Agent is the floating bubble (not a nav slot); the long tail stays in the
// drawer. Chat opens the docked drawer (full-screen on mobile) rather than the
// orphaned /chat page.
export function MobileBottomNav({
  orgSlug,
  orgId,
}: {
  orgSlug: string | undefined;
  orgId?: string;
}) {
  const pathname = usePathname();
  const { openDrawer, isOpen } = useDrawers();
  // useTotalUnread must be called unconditionally (before any early return) to
  // keep hook order stable. An empty orgId is a no-op inside the hook.
  const totalUnread = useTotalUnread(orgId ?? "");

  // Read the user's chosen slots; SSR + first paint use the default to avoid a
  // hydration mismatch, then sync from localStorage on mount + on change.
  const [slots, setSlots] = useState<string[]>(DEFAULT_MOBILE_NAV);
  useEffect(() => {
    const sync = () => setSlots(loadMobileNav());
    sync();
    window.addEventListener(MOBILE_NAV_CHANGED_EVENT, sync);
    window.addEventListener("storage", sync); // other-tab changes
    return () => {
      window.removeEventListener(MOBILE_NAV_CHANGED_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  if (!orgSlug) return null;

  // Build the 5 cells: [slot0, slot1, Chat(center), slot2, slot3].
  const left = slots.slice(0, 2);
  const right = slots.slice(2, 4);
  const ordered = [...left, "__chat__", ...right];

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-30 grid grid-cols-5 border-t border-[var(--border)] bg-[var(--bg)] pb-[env(safe-area-inset-bottom)] md:hidden">
      {ordered.map((key, i) => {
        if (key === "__chat__") {
          const active = isOpen("chat");
          return (
            <button
              key="chat"
              type="button"
              onClick={() => openDrawer("chat")}
              aria-pressed={active}
              className={cn(
                "flex min-h-[52px] flex-col items-center justify-center gap-1 py-2.5 text-[11px]",
                active
                  ? "text-[var(--primary)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text)]",
              )}
            >
              <div className="relative">
                <MessageCircle
                  className={cn(
                    "h-5 w-5",
                    active && "drop-shadow-[0_0_6px_var(--primary)]",
                  )}
                />
                {totalUnread > 0 && (
                  <span className="absolute -top-1 -right-2 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-1 text-[8px] font-bold text-destructive-foreground">
                    {totalUnread > 9 ? "9+" : totalUnread}
                  </span>
                )}
              </div>
              Chat
            </button>
          );
        }

        const dest = destForKey(key);
        if (!dest) return <div key={`empty-${i}`} />;
        const Icon = dest.icon;
        const href = `/${orgSlug}${dest.href}`;
        const isActive =
          pathname === href ||
          (dest.href !== "" && pathname.startsWith(href + "/"));
        return (
          <Link
            key={dest.key}
            href={href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex min-h-[52px] flex-col items-center justify-center gap-1 py-2.5 text-[11px]",
              isActive
                ? "text-[var(--primary)]"
                : "text-[var(--text-muted)] hover:text-[var(--text)]",
            )}
          >
            <div className="relative">
              <Icon
                className={cn(
                  "h-5 w-5",
                  isActive && "drop-shadow-[0_0_6px_var(--primary)]",
                )}
              />
            </div>
            {dest.label}
          </Link>
        );
      })}
    </nav>
  );
}
