"use client";
/**
 * "Mentioned in …" backlinks panel — lists the chat messages, comments, notes,
 * and work items that @-reference a given entity. Renders nothing when empty.
 */
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import {
  MessageSquare,
  MessageCircle,
  FileText,
  CircleDot,
  Link2,
  type LucideIcon,
} from "lucide-react";
import { useOrgQueryKey } from "@/lib/query/keys";
import type { EntityType } from "@/lib/mentions/refs";

type Backlink = {
  sourceType: string;
  sourceId: string;
  label: string;
  url: string | null;
};

const SOURCE_ICON: Record<string, LucideIcon> = {
  chatMessage: MessageSquare,
  comment: MessageCircle,
  note: FileText,
  workItem: CircleDot,
};

export function MentionedIn({
  orgId,
  type,
  id,
  className,
}: {
  orgId: string;
  type: EntityType;
  id: string;
  className?: string;
}) {
  const key = useOrgQueryKey("backlinks", type, id);
  const { data } = useQuery({
    queryKey: key,
    staleTime: 30_000,
    queryFn: async (): Promise<Backlink[]> => {
      const r = await fetch(
        `/api/v1/orgs/${orgId}/mentions/backlinks?type=${type}&id=${id}`,
      );
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j) ? (j as Backlink[]) : [];
    },
  });
  const items = data ?? [];
  if (items.length === 0) return null;

  return (
    <div className={className}>
      <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Link2 className="h-3.5 w-3.5" />
        Mentioned in ({items.length})
      </h4>
      <ul className="space-y-1">
        {items.map((bl) => {
          const Icon = SOURCE_ICON[bl.sourceType] ?? Link2;
          const inner = (
            <span className="flex items-center gap-1.5 truncate">
              <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{bl.label}</span>
            </span>
          );
          return (
            <li key={`${bl.sourceType}:${bl.sourceId}`} className="text-sm">
              {bl.url ? (
                <Link href={bl.url} className="hover:underline text-foreground">
                  {inner}
                </Link>
              ) : (
                <span className="text-muted-foreground">{inner}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
