"use client";

/**
 * Starred saved filters under Issues in the sidebar (query design §10.4), in
 * the order the viewer starred them, at most ten. Shown only where the org
 * has CQL on, and only while the rail is open.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCqlSchema } from "./use-cql";
import { useSavedFilters } from "./use-saved-filters";

export function SidebarFilters({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { enabled } = useCqlSchema(orgId);
  const { data = [] } = useSavedFilters(orgId, enabled);
  const active = useSearchParams().get("filter");
  const starred = data
    .filter((f) => f.favorite)
    .sort((a, b) => (a.favoriteOrder ?? 0) - (b.favoriteOrder ?? 0))
    .slice(0, 10);
  if (!enabled || starred.length === 0) return null;
  return (
    <ul aria-label="Starred filters" className="mb-1 ml-6 space-y-0.5 border-l border-[var(--border)] pl-2">
      {starred.map((f) => (
        <li key={f.id}>
          <Link
            href={`/${orgSlug}/issues?filter=${f.id}`}
            aria-current={active === f.id ? "page" : undefined}
            className={cn(
              "flex items-center gap-1.5 truncate rounded px-1.5 py-1 text-xs",
              active === f.id ? "text-[var(--primary)]" : "text-[var(--text-muted)] hover:text-[var(--text)]",
            )}
          >
            <Star className="h-3 w-3 shrink-0" aria-hidden />
            <span className="truncate">{f.name}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
