"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export type Crumb = { label: string; href: string };

export function buildCrumbs(
  pathname: string,
  orgs: { slug: string; name: string }[],
): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return [];

  const orgSlug = segments[0];
  const org = orgs.find((o) => o.slug === orgSlug);
  const crumbs: Crumb[] = [{ label: org?.name ?? orgSlug, href: `/${orgSlug}` }];

  for (let i = 1; i < segments.length; i++) {
    const label = titleCase(segments[i]);
    if (!label) continue;
    const href = "/" + segments.slice(0, i + 1).join("/");
    crumbs.push({ label, href });
  }
  return crumbs;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Slugs whose canonical casing isn't recoverable by naive title-casing
// (acronyms, mixed-case). Keeps the breadcrumb in sync with the page title
// (e.g. "CRM", not "Crm").
const LABEL_OVERRIDES: Record<string, string> = {
  crm: "CRM",
  okrs: "OKRs",
  kpis: "KPIs",
  "mcp-servers": "MCP Servers",
};

function titleCase(segment: string): string {
  if (UUID_RE.test(segment)) return "";
  const override = LABEL_OVERRIDES[segment.toLowerCase()];
  if (override) return override;
  return segment
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

export function Breadcrumbs({
  orgs,
}: {
  orgs: { slug: string; name: string }[];
}) {
  const pathname = usePathname();
  const crumbs = buildCrumbs(pathname, orgs);
  if (crumbs.length === 0) return null;

  return (
    <nav
      aria-label="Breadcrumb"
      className="flex min-w-0 items-center gap-1 text-sm"
    >
      {crumbs.map((c, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <span
            key={c.href}
            // On phones the full trail wraps and collides with the topbar
            // icons, so collapse to just the current page (the bottom nav +
            // hamburger provide navigation there); show the full trail at sm+.
            className={cn(
              "flex items-center gap-1",
              isLast ? "min-w-0" : "hidden sm:flex",
            )}
          >
            {i > 0 && (
              <ChevronRight
                className={cn(
                  "h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]",
                  isLast && "hidden sm:block",
                )}
              />
            )}
            {isLast ? (
              <span className="truncate font-medium">{c.label}</span>
            ) : (
              <Link
                href={c.href}
                className="whitespace-nowrap text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                {c.label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
