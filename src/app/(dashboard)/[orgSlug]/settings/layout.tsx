"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  Settings,
  User,
  Puzzle,
  Webhook,
  Palette,
  SlidersHorizontal,
  ListFilter,
  Shield,
  ShieldCheck,
  Tag,
  ScrollText,
  LayoutGrid,
  Server,
  UserCog,
  Cpu,
  Bot,
  Gavel,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const settingsNav = [
  { icon: Settings, label: "General", href: "/settings" },
  { icon: User, label: "Profile", href: "/settings/profile" },
  { icon: Puzzle, label: "Integrations", href: "/settings/integrations" },
  { icon: Server, label: "MCP Servers", href: "/settings/mcp-servers" },
  { icon: Cpu, label: "Runtime Config", href: "/settings/runtime-config" },
  { icon: Bot, label: "Agent Policy", href: "/settings/agent-policy" },
  { icon: Gavel, label: "Agent Governance", href: "/settings/agent-governance" },
  { icon: Webhook, label: "Webhooks", href: "/settings/webhooks" },
  { icon: Palette, label: "Themes", href: "/settings/themes" },
  { icon: SlidersHorizontal, label: "Preferences", href: "/settings/preferences" },
  { icon: ListFilter, label: "Custom Fields", href: "/settings/custom-fields" },
  { icon: LayoutGrid, label: "Templates", href: "/settings/templates" },
  { icon: UserCog, label: "Roles & Access", href: "/settings/roles" },
  { icon: Shield, label: "Security", href: "/settings/security" },
  { icon: ShieldCheck, label: "Compliance", href: "/settings/compliance" },
  { icon: Tag, label: "Classifications", href: "/settings/classifications" },
  { icon: ScrollText, label: "Audit Logs", href: "/settings/audit-logs" },
];

function isNavActive(itemHref: string, pathname: string, orgSlug: string) {
  const href = `/${orgSlug}${itemHref}`;
  // "/settings" (General) is the parent of every other settings route, so it
  // must match exactly; the rest use segment-aware prefix matching.
  return itemHref === "/settings"
    ? pathname === href
    : pathname === href || pathname.startsWith(href + "/");
}

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const orgSlug = pathname.split("/")[1];

  const active = settingsNav.find((item) =>
    isNavActive(item.href, pathname, orgSlug),
  );

  return (
    <div className="flex min-h-full flex-col md:flex-row">
      {/* Mobile (< md): a compact picker so the sub-nav doesn't crush the
          content into a ~160px column. */}
      <div className="border-b bg-muted/30 p-4 md:hidden">
        <Select
          items={Object.fromEntries(settingsNav.map((i) => [i.href, i.label]))}
          value={active?.href ?? "/settings"}
          onValueChange={(href) => router.push(`/${orgSlug}${href}`)}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Settings section" />
          </SelectTrigger>
          <SelectContent>
            {settingsNav.map((item) => (
              <SelectItem key={item.href} value={item.href}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Desktop (md+): full sidebar. */}
      <nav className="hidden w-56 shrink-0 border-r bg-muted/30 p-4 md:block">
        <h2 className="px-3 mb-4 text-sm font-semibold text-muted-foreground uppercase tracking-wider">
          Settings
        </h2>
        <ul className="space-y-1">
          {settingsNav.map((item) => {
            const href = `/${orgSlug}${item.href}`;
            const isActive = isNavActive(item.href, pathname, orgSlug);

            return (
              <li key={item.href}>
                <Link
                  href={href}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                    isActive
                      ? "bg-background text-foreground font-medium shadow-sm"
                      : "text-muted-foreground hover:bg-background/50 hover:text-foreground"
                  )}
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  <span>{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
