"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { motion as fm, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Settings,
  ChevronLeft,
  ChevronRight,
  BarChart3,
  Briefcase,
  FileText,
  Clock,
  DollarSign,
  Video,
  MessageSquare,
  Sparkles,
  LogOut,
  Sun,
  Moon,
  ChevronsUpDown,
  FolderKanban,
  Users,
  Mic,
  Megaphone,
  FileSignature,
  Package,
  Handshake,
  BookOpen,
} from "lucide-react";
import { CosmosMark } from "@/components/brand/cosmos-mark";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { motion } from "@/lib/motion";

interface AppSidebarProps {
  open: boolean;
  onToggle: () => void;
  orgs: {
    id: string;
    slug: string;
    name: string;
    plan: string;
    logoUrl: string | null;
    role: string;
  }[];
  user: {
    id: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
  };
}

const navItems = [
  { icon: LayoutDashboard, label: "Overview", href: "" },
  { icon: FolderKanban, label: "Projects", href: "/projects" },
  { icon: MessageSquare, label: "Chat", href: "/chat" },
  { icon: Briefcase, label: "CRM", href: "/crm" },
  { icon: Handshake, label: "Partners", href: "/partners" },
  { icon: Package, label: "Products", href: "/products" },
  { icon: FileSignature, label: "Contracts", href: "/contracts" },
  { icon: Clock, label: "Time Tracking", href: "/time-tracking" },
  { icon: DollarSign, label: "Finance", href: "/finance" },
  { icon: BookOpen, label: "Accounting", href: "/finance/accounting" },
  { icon: Video, label: "Meetings", href: "/meetings" },
  { icon: Sparkles, label: "Assistant", href: "/assistant" },
  { icon: FileText, label: "Notes", href: "/notes" },
  { icon: Megaphone, label: "Feedback", href: "/feedback" },
  { icon: Users, label: "Team", href: "/team" },
  { icon: BarChart3, label: "Analytics", href: "/analytics" },
  { icon: Settings, label: "Settings", href: "/settings" },
];

export function AppSidebar({ open, onToggle, orgs, user }: AppSidebarProps) {
  const pathname = usePathname();
  const orgSlug = pathname.split("/")[1];
  const currentOrg = orgs.find((o) => o.slug === orgSlug);

  return (
    <fm.aside
      animate={{ width: open ? 256 : 56 }}
      transition={motion.spring}
      className="flex h-full flex-col border-r bg-[image:var(--sidebar-gradient)] text-[var(--text)]"
    >
      {/* Header */}
      <div className="flex h-14 shrink-0 items-center justify-between px-3">
        <Link href="/" className="flex items-center gap-2 min-w-0">
          <CosmosMark size={open ? "md" : "sm"} />
          <AnimatePresence>
            {open && (
              <fm.span
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { delay: 0.1 } }}
                exit={{ opacity: 0 }}
                className="font-semibold text-sm truncate"
              >
                COSMOS
              </fm.span>
            )}
          </AnimatePresence>
        </Link>
        <button
          onClick={onToggle}
          aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
          className="rounded p-1 hover:bg-[var(--primary-tint)] text-[var(--text-muted)]"
        >
          {open ? (
            <ChevronLeft className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </button>
      </div>

      <div className="shrink-0 border-b border-[var(--border)]" />

      {/* Nav */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
        {navItems.map((item) => {
          const href = currentOrg ? `/${currentOrg.slug}${item.href}` : "/";
          // The org-root link (Overview, empty href) must match EXACTLY —
          // otherwise a prefix check lights it up on every sub-page, double-
          // highlighting two items at once. All other links use segment-aware
          // prefix matching so e.g. /projects stays active under /projects/r11,
          // BUT a parent item must NOT stay active when a more-specific child
          // item's href is itself a prefix of (or exact match for) the current
          // path — e.g. Finance (/finance) must not highlight when Accounting
          // (/finance/accounting) is the active item.
          const isActive = (() => {
            if (item.href === "") return pathname === href;
            if (pathname !== href && !pathname.startsWith(href + "/"))
              return false;
            // Suppress the parent when a longer sibling item also matches.
            const longerSiblingMatches = navItems.some((other) => {
              if (other === item) return false;
              if (!other.href.startsWith(item.href + "/")) return false;
              const otherHref = currentOrg
                ? `/${currentOrg.slug}${other.href}`
                : "/";
              return (
                pathname === otherHref ||
                pathname.startsWith(otherHref + "/")
              );
            });
            return !longerSiblingMatches;
          })();
          return (
            <Link
              key={item.label}
              href={href}
              title={!open ? item.label : undefined}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-md px-2.5 py-2 text-sm transition-colors",
                isActive
                  ? "bg-[var(--primary-tint)] text-[var(--primary)] border-l-2 border-[var(--primary)] pl-2"
                  : "text-[var(--text-muted)] hover:bg-[var(--primary-tint)] hover:text-[var(--text)]",
              )}
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {open && <span className="truncate">{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      <div className="shrink-0 border-t border-[var(--border)]" />

      {/* Org switcher */}
      <div className="shrink-0 p-2">
        <OrgSwitcher orgs={orgs} currentOrg={currentOrg} open={open} />
      </div>

      <div className="shrink-0 border-t border-[var(--border)]" />

      {/* User card */}
      <div className="shrink-0 p-2">
        <UserCard user={user} open={open} />
      </div>
    </fm.aside>
  );
}

function OrgSwitcher({
  orgs,
  currentOrg,
  open,
}: {
  orgs: AppSidebarProps["orgs"];
  currentOrg: AppSidebarProps["orgs"][number] | undefined;
  open: boolean;
}) {
  const router = useRouter();
  const label = currentOrg?.name ?? "No org";
  const initial = (currentOrg?.name ?? "?").charAt(0).toUpperCase();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-[var(--primary-tint)] transition-colors">
        {currentOrg?.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={currentOrg.logoUrl}
            alt=""
            className="h-6 w-6 rounded shrink-0"
          />
        ) : (
          <div className="h-6 w-6 rounded bg-[var(--primary-tint)] flex items-center justify-center text-[10px] font-semibold text-[var(--primary)] shrink-0">
            {initial}
          </div>
        )}
        {open && (
          <>
            <span className="truncate flex-1 text-left">{label}</span>
            <ChevronsUpDown className="h-3.5 w-3.5 text-[var(--text-muted)]" />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {orgs.map((o) => (
          <DropdownMenuItem key={o.id} onClick={() => router.push(`/${o.slug}`)}>
            {o.name}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push("/onboarding")}>
          + Create organization
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserCard({
  user,
  open,
}: {
  user: AppSidebarProps["user"];
  open: boolean;
}) {
  const router = useRouter();
  const initials = user.displayName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-[var(--primary-tint)] transition-colors">
        <Avatar className="h-6 w-6 shrink-0">
          <AvatarImage src={user.avatarUrl ?? undefined} />
          <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
        </Avatar>
        {open && (
          <div className="flex-1 min-w-0 text-left">
            <p className="truncate text-sm font-medium">{user.displayName}</p>
            <p className="truncate text-[10px] text-[var(--text-muted)]">
              v{process.env.NEXT_PUBLIC_APP_VERSION}
            </p>
          </div>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuItem
          onClick={(e) => {
            e.preventDefault();
            const current =
              typeof window !== "undefined" &&
              window.localStorage.getItem("cosmos:wake-word-enabled") ===
                "true";
            window.dispatchEvent(
              new CustomEvent("cosmos:wake-word:toggle", {
                detail: !current,
              }),
            );
          }}
        >
          <Mic className="mr-2 h-4 w-4" /> Toggle &quot;Hey COSMOS&quot; voice
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5">
          <p className="text-sm font-medium">{user.displayName}</p>
          <p className="text-xs text-[var(--text-muted)]">{user.email}</p>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => setTheme("light")}>
          <Sun className="mr-2 h-4 w-4" /> Light mode
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("dark")}>
          <Moon className="mr-2 h-4 w-4" /> Dark mode
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={signOut}>
          <LogOut className="mr-2 h-4 w-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

async function setTheme(mode: "dark" | "light") {
  await fetch("/api/theme", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  document.documentElement.classList.remove("dark", "light");
  document.documentElement.classList.add(mode);
}
