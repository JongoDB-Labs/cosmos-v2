"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, FolderKanban, MessageCircle, FileText, Video } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTotalUnread } from "@/hooks/use-total-unread";

// The five core scrum destinations, Chat centered. The Agent is the floating
// bubble (not a nav slot); the long tail (Team, CRM, Finance, Settings, …)
// stays in the drawer. Closes the gap where Notes/Meetings were unreachable on
// mobile without opening the drawer.
const items = [
  { icon: LayoutDashboard, label: "Overview", href: "" },
  { icon: FolderKanban, label: "Projects", href: "/projects" },
  { icon: MessageCircle, label: "Chat", href: "/chat" },
  { icon: FileText, label: "Notes", href: "/notes" },
  { icon: Video, label: "Meetings", href: "/meetings" },
];

export function MobileBottomNav({
  orgSlug,
  orgId,
}: {
  orgSlug: string | undefined;
  orgId?: string;
}) {
  const pathname = usePathname();
  // useTotalUnread must be called unconditionally (before any early return) to
  // keep hook order stable. An empty orgId is a no-op inside the hook.
  const totalUnread = useTotalUnread(orgId ?? "");

  if (!orgSlug) return null;
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-30 grid grid-cols-5 border-t border-[var(--border)] bg-[var(--bg)] pb-[env(safe-area-inset-bottom)] md:hidden">
      {items.map((item) => {
        const href = `/${orgSlug}${item.href}`;
        const isActive =
          pathname === href ||
          (item.href !== "" && pathname.startsWith(href + "/"));
        return (
          <Link
            key={item.label}
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
              <item.icon
                className={cn(
                  "h-5 w-5",
                  isActive && "drop-shadow-[0_0_6px_var(--primary)]",
                )}
              />
              {item.href === "/chat" && totalUnread > 0 && (
                <span className="absolute -top-1 -right-2 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-1 text-[8px] font-bold text-destructive-foreground">
                  {totalUnread > 9 ? "9+" : totalUnread}
                </span>
              )}
            </div>
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
