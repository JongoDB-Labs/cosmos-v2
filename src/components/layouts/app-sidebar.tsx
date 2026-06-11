"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { motion as fm, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import {
  PanelLeftClose,
  PanelLeft,
  LogOut,
  Sun,
  Moon,
  ChevronsUpDown,
  Mic,
  MessageSquarePlus,
  KeyRound,
  MailCheck,
} from "lucide-react";
import { BrandLogo } from "@/components/brand/brand-logo";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { motion } from "@/lib/motion";
import { usePermissions } from "@/components/providers/permissions-provider";
import {
  SIDEBAR_NAV,
  visibleNav,
  applyAdminLayout,
  type NavEntry,
} from "./nav-config";
import { isHrefActive, resolveHref, hrefFor } from "./nav-active";
import { NavGroup } from "./nav-group";
import { visibleTopbarNav } from "./topbar-nav";
import { useNavGroups } from "@/lib/hooks/use-nav-groups";

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
  /** Platform/system admin (INTERNAL_ADMINS) — surfaces the System Admin menu. */
  isSystemAdmin?: boolean;
  /** Optional admin nav layout from Organization.settings.nav. */
  navLayout?: { order?: string[]; hidden?: string[] };
  /**
   * Render the topbar-only destinations (Notes / Chat / Team / Meetings +
   * Feedback) as an extra "Workspace" section. Set on the MOBILE drawer, where
   * the topbar's moved-nav is `hidden md:flex` — without this they'd be
   * unreachable on a phone (item 2). The desktop rail leaves it off because the
   * topbar already surfaces them.
   */
  showMovedNav?: boolean;
}

export function AppSidebar({
  open,
  onToggle,
  orgs,
  user,
  isSystemAdmin = false,
  navLayout,
  showMovedNav = false,
}: AppSidebarProps) {
  const pathname = usePathname();
  // Derive the effective org slug from a MATCHED membership — NOT the raw path
  // segment. On non-org routes (/onboarding, /admin) the first segment is a
  // truthy string ("onboarding") that no org matches, so currentOrg is
  // undefined and orgSlug stays undefined. That lets resolveHref() return its
  // NO_MATCH sentinel so nothing (including Overview) highlights.
  const currentOrg = orgs.find((o) => o.slug === pathname.split("/")[1]);
  const orgSlug = currentOrg?.slug;
  const { can } = usePermissions();

  // RBAC/ABAC-gated: drop items + groups the user can't access (item 4),
  // then apply any admin-defined order/visibility (item 12).
  const entries = applyAdminLayout(visibleNav(SIDEBAR_NAV, can), navLayout);

  // Every visible leaf href across the WHOLE nav (top-level leaves + all group
  // children), for cross-group sibling-suppression — e.g. /finance (Accounting)
  // must NOT stay active when /finance/invoices (CRM) is the page.
  const allLeafHrefs = entries.flatMap((e) =>
    e.type === "group"
      ? e.children.map((c) => resolveHref(orgSlug, c.href))
      : [resolveHref(orgSlug, e.href)],
  );

  // Seed expanded groups: any group whose child route is active starts open.
  const activeGroupIds = entries
    .filter((e): e is Extract<NavEntry, { type: "group" }> => e.type === "group")
    .filter((g) =>
      g.children.some((c) =>
        isHrefActive(
          pathname,
          resolveHref(orgSlug, c.href),
          c.href === "",
          g.children.map((cc) => resolveHref(orgSlug, cc.href)),
        ),
      ),
    )
    .map((g) => g.id);

  const { isExpanded, toggle } = useNavGroups(activeGroupIds);

  return (
    <fm.aside
      animate={{ width: open ? 256 : 56 }}
      transition={motion.spring}
      className="flex h-full flex-col border-r bg-[image:var(--sidebar-gradient)] text-[var(--text)]"
    >
      {/* Header — brand slot + single toggle (item 1: logo keeps a constant
          size; item 2: one consolidated collapse control). */}
      <div className="flex h-14 shrink-0 items-center justify-between px-3">
        <Link href="/" className="flex min-w-0 items-center gap-2">
          <BrandLogo logoUrl={currentOrg?.logoUrl} orgName={currentOrg?.name} />
          <AnimatePresence>
            {open && (
              <fm.span
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { delay: 0.1 } }}
                exit={{ opacity: 0 }}
                className="truncate text-sm font-semibold"
              >
                {currentOrg?.name ?? "COSMOS"}
              </fm.span>
            )}
          </AnimatePresence>
        </Link>
        {/* Collapse control: only on the MOBILE drawer (showMovedNav), where it
            doubles as the drawer's close button. On the DESKTOP rail it's gone —
            the topbar hamburger is the single expand/collapse control — so the
            icon no longer crowds/covers the brand logo in the 56px collapsed
            rail. */}
        {showMovedNav && (
          <button
            onClick={onToggle}
            aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
            className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--primary-tint)]"
          >
            {open ? (
              <PanelLeftClose className="h-4 w-4" />
            ) : (
              <PanelLeft className="h-4 w-4" />
            )}
          </button>
        )}
      </div>

      <div className="shrink-0 border-b border-[var(--border)]" />

      {/* Nav */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
        {entries.map((entry) => {
          if (entry.type === "group") {
            return (
              <NavGroup
                key={entry.id}
                group={entry}
                orgSlug={orgSlug}
                pathname={pathname}
                expanded={isExpanded(entry.id)}
                onToggle={() => toggle(entry.id)}
                railOpen={open}
                allHrefs={allLeafHrefs}
              />
            );
          }
          const active = isHrefActive(
            pathname,
            resolveHref(orgSlug, entry.href),
            entry.href === "",
            allLeafHrefs,
          );
          const Icon = entry.icon;
          return (
            <Link
              key={entry.id}
              href={hrefFor(orgSlug, entry.href)}
              title={!open ? entry.label : undefined}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-md px-2.5 py-2 text-sm transition-colors",
                active
                  ? "border-l-2 border-[var(--primary)] bg-[var(--primary-tint)] pl-2 text-[var(--primary)]"
                  : "text-[var(--text-muted)] hover:bg-[var(--primary-tint)] hover:text-[var(--text)]",
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {open && <span className="truncate">{entry.label}</span>}
            </Link>
          );
        })}

        {/* Workspace section: the topbar-only destinations, surfaced here on
            the mobile drawer so every primary destination stays reachable on a
            phone (item 2). The desktop topbar renders these instead. */}
        {showMovedNav && (
          <div className="mt-2 space-y-0.5 border-t border-[var(--border)] pt-2">
            {open && (
              <p className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                Workspace
              </p>
            )}
            {visibleTopbarNav(can).map((item) => {
              const active = isHrefActive(
                pathname,
                resolveHref(orgSlug, item.href),
                false,
              );
              const Icon = item.icon;
              return (
                <Link
                  key={item.id}
                  href={hrefFor(orgSlug, item.href)}
                  title={!open ? item.label : undefined}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-2.5 py-2 text-sm transition-colors",
                    active
                      ? "border-l-2 border-[var(--primary)] bg-[var(--primary-tint)] pl-2 text-[var(--primary)]"
                      : "text-[var(--text-muted)] hover:bg-[var(--primary-tint)] hover:text-[var(--text)]",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {open && <span className="truncate">{item.label}</span>}
                </Link>
              );
            })}
            {/* Feedback also lives only in the topbar (sm:flex) — surface it
                here too so it's reachable on mobile. */}
            {currentOrg && (
              <Link
                href={resolveHref(orgSlug, "/feedback")}
                title={!open ? "Feedback" : undefined}
                aria-current={
                  isHrefActive(
                    pathname,
                    resolveHref(orgSlug, "/feedback"),
                    false,
                  )
                    ? "page"
                    : undefined
                }
                className={cn(
                  "flex items-center gap-3 rounded-md px-2.5 py-2 text-sm transition-colors",
                  isHrefActive(
                    pathname,
                    resolveHref(orgSlug, "/feedback"),
                    false,
                  )
                    ? "border-l-2 border-[var(--primary)] bg-[var(--primary-tint)] pl-2 text-[var(--primary)]"
                    : "text-[var(--text-muted)] hover:bg-[var(--primary-tint)] hover:text-[var(--text)]",
                )}
              >
                <MessageSquarePlus className="h-4 w-4 shrink-0" />
                {open && <span className="truncate">Feedback</span>}
              </Link>
            )}
          </div>
        )}
      </nav>

      <div className="shrink-0 border-t border-[var(--border)]" />

      {/* Org switcher */}
      <div className="shrink-0 p-2">
        <OrgSwitcher orgs={orgs} currentOrg={currentOrg} open={open} />
      </div>

      <div className="shrink-0 border-t border-[var(--border)]" />

      {/* User card */}
      <div className="shrink-0 p-2">
        <UserCard user={user} open={open} isSystemAdmin={isSystemAdmin} />
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
      <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-[var(--primary-tint)]">
        {currentOrg?.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={currentOrg.logoUrl}
            alt=""
            className="h-6 w-6 shrink-0 rounded object-contain"
          />
        ) : (
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-[var(--primary-tint)] text-[10px] font-semibold text-[var(--primary)]">
            {initial}
          </div>
        )}
        {open && (
          <>
            <span className="flex-1 truncate text-left">{label}</span>
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
  isSystemAdmin = false,
}: {
  user: AppSidebarProps["user"];
  open: boolean;
  isSystemAdmin?: boolean;
}) {
  const router = useRouter();
  const initials = user.displayName
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  // Reflect the "Hey COSMOS" wake-word state in the toggle (filled when on +
  // a listening warning) so it's not a blind switch. Mirrors WakeWordProvider's
  // localStorage + custom-event contract.
  const [wakeWordOn, setWakeWordOn] = useState(false);
  useEffect(() => {
    const read = () =>
      setWakeWordOn(
        typeof window !== "undefined" &&
          window.localStorage.getItem("cosmos:wake-word-enabled") === "true",
      );
    read();
    const onToggle = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setWakeWordOn((prev) => (typeof detail === "boolean" ? detail : !prev));
    };
    window.addEventListener("cosmos:wake-word:toggle", onToggle);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener("cosmos:wake-word:toggle", onToggle);
      window.removeEventListener("storage", read);
    };
  }, []);

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-[var(--primary-tint)]">
        <Avatar className="h-6 w-6 shrink-0">
          <AvatarImage src={user.avatarUrl ?? undefined} />
          <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
        </Avatar>
        {open && (
          <div className="min-w-0 flex-1 text-left">
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
            window.dispatchEvent(
              new CustomEvent("cosmos:wake-word:toggle", {
                detail: !wakeWordOn,
              }),
            );
          }}
        >
          <Mic
            className={cn(
              "mr-2 h-4 w-4",
              wakeWordOn && "fill-[var(--primary)] text-[var(--primary)]",
            )}
          />
          <span className="flex-1">&quot;Hey COSMOS&quot; voice</span>
          {wakeWordOn ? (
            <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-[var(--primary-tint)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--primary)]">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--primary)] opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--primary)]" />
              </span>
              On
            </span>
          ) : (
            <span className="ml-2 text-[10px] text-[var(--text-muted)]">Off</span>
          )}
        </DropdownMenuItem>
        {wakeWordOn && (
          <p className="px-2 pb-1 text-[10px] leading-tight text-[var(--text-muted)]">
            Your mic is on, listening for “Hey COSMOS”.
          </p>
        )}
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5">
          <p className="text-sm font-medium">{user.displayName}</p>
          <p className="text-xs text-[var(--text-muted)]">{user.email}</p>
        </div>
        {isSystemAdmin && (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
              System administration
            </div>
            <DropdownMenuItem onClick={() => router.push("/admin/sign-in-providers")}>
              <KeyRound className="mr-2 h-4 w-4" /> Sign-in providers
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push("/admin/allowlist")}>
              <MailCheck className="mr-2 h-4 w-4" /> Email allowlist
            </DropdownMenuItem>
          </>
        )}
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
