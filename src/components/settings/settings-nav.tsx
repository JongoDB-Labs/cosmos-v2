"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { SettingsNavGroup } from "@/lib/rbac/settings-access";

function isNavActive(itemHref: string, pathname: string, orgSlug: string) {
  const href = `/${orgSlug}${itemHref}`;
  // "/settings" (General) is the parent of every other settings route, so it
  // must match exactly; the rest use segment-aware prefix matching.
  return itemHref === "/settings"
    ? pathname === href
    : pathname === href || pathname.startsWith(href + "/");
}

export function SettingsNav({
  groups,
  orgSlug,
}: {
  groups: SettingsNavGroup[];
  orgSlug: string;
}) {
  const pathname = usePathname();
  const router = useRouter();

  const flat = groups.flatMap((g) => g.items);
  const active = flat.find((i) => isNavActive(i.href, pathname, orgSlug));

  return (
    <>
      {/* Mobile (< md): grouped picker so sub-nav doesn't crush content. */}
      <div className="border-b bg-muted/30 p-4 md:hidden">
        <Select
          value={active?.href ?? "/settings"}
          onValueChange={(href) => href && router.push(`/${orgSlug}${href}`)}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Settings section" />
          </SelectTrigger>
          <SelectContent>
            {groups.map((g) => (
              <div key={g.label}>
                <p className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                  {g.label}
                </p>
                {g.items.map((i) => (
                  <SelectItem key={i.href} value={i.href}>
                    {i.label}
                  </SelectItem>
                ))}
              </div>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Desktop (md+): grouped sidebar. */}
      <nav className="hidden w-56 shrink-0 border-r bg-muted/30 p-4 md:flex md:flex-col md:gap-4">
        {groups.map((g) => (
          <div key={g.label} className="flex flex-col gap-1">
            <p className="px-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {g.label}
            </p>
            <ul className="space-y-1">
              {g.items.map((i) => {
                const active = isNavActive(i.href, pathname, orgSlug);
                return (
                  <li key={i.href}>
                    <Link
                      href={`/${orgSlug}${i.href}`}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                        active
                          ? "bg-background text-foreground font-medium shadow-sm"
                          : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
                      )}
                    >
                      <i.icon className="h-4 w-4 shrink-0" />
                      <span>{i.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </>
  );
}
