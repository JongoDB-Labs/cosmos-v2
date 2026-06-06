"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, FolderKanban, MessageCircle, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTotalUnread } from "@/hooks/use-total-unread";

// Projects is the central concept of the app, so it earns a slot in the
// bottom four; the long tail (CRM, Finance, Notes, …) stays in the drawer.
const items = [
  { icon: LayoutDashboard, label: "Overview", href: "" },
  { icon: FolderKanban, label: "Projects", href: "/projects" },
  { icon: MessageCircle, label: "Chat", href: "/chat" },
  { icon: Sparkles, label: "Assistant", href: "/assistant" },
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
    <nav className="fixed bottom-0 left-0 right-0 z-30 grid grid-cols-4 border-t border-[var(--border)] bg-[var(--bg)] pb-[env(safe-area-inset-bottom)] md:hidden">
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
              "flex flex-col items-center justify-center gap-1 py-2 text-[11px]",
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
