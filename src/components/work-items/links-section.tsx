"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Link2, Plus, Search, Loader2, Trash2, X } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { notifyError } from "@/lib/errors/notify";
import { jsonFetch } from "@/lib/query/json-fetcher";
import type { LinkType } from "@prisma/client";

interface WorkItemLinkDto {
  id: string;
  type: LinkType;
  sourceItemId: string;
  targetItemId: string;
  sourceTicketNumber: number;
  sourceTitle: string;
  targetTicketNumber: number;
  targetTitle: string;
  createdAt: string;
}

interface SearchRow {
  id: string;
  ticketNumber: number;
  ticketKey: string;
  title: string;
}

/**
 * Relationship labels from the CURRENT item's perspective. A link is a directed
 * edge `source --type--> target`; when the open item is the SOURCE we show the
 * forward label, when it's the TARGET we show the inverse. The "add" picker only
 * creates links where this item is the source, so it offers the forward set.
 */
const FORWARD_LABEL: Record<LinkType, string> = {
  BLOCKS: "Blocks",
  BLOCKED_BY: "Blocked by",
  RELATES: "Relates to",
  DUPLICATES: "Duplicates",
  PREDECESSOR: "Predecessor of",
  SUCCESSOR: "Successor of",
  CLONES: "Clones",
};

const INVERSE_LABEL: Record<LinkType, string> = {
  BLOCKS: "Blocked by",
  BLOCKED_BY: "Blocks",
  RELATES: "Relates to",
  DUPLICATES: "Duplicated by",
  PREDECESSOR: "Successor of",
  SUCCESSOR: "Predecessor of",
  CLONES: "Cloned by",
};

const ADD_OPTIONS: { value: LinkType; label: string }[] = [
  { value: "BLOCKS", label: "Blocks" },
  { value: "BLOCKED_BY", label: "Blocked by" },
  { value: "RELATES", label: "Relates to" },
  { value: "DUPLICATES", label: "Duplicates" },
  { value: "PREDECESSOR", label: "Predecessor of" },
  { value: "SUCCESSOR", label: "Successor of" },
  { value: "CLONES", label: "Clones" },
];

export function WorkItemLinksSection({
  orgId,
  projectId,
  itemId,
  canEdit,
  onOpenItem,
}: {
  orgId: string;
  projectId: string;
  itemId: string;
  canEdit: boolean;
  /** Open another work item in the detail sheet (same project). */
  onOpenItem?: (id: string) => void;
}) {
  const linksBase = `/api/v1/orgs/${orgId}/projects/${projectId}/work-item-links`;
  const [links, setLinks] = useState<WorkItemLinkDto[]>([]);
  const [loading, setLoading] = useState(true);

  const [adding, setAdding] = useState(false);
  const [relType, setRelType] = useState<LinkType>("RELATES");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await jsonFetch<WorkItemLinkDto[]>(`${linksBase}?item=${itemId}`);
      setLinks(data);
    } catch (err) {
      notifyError(err, "Couldn't load linked items.");
    } finally {
      setLoading(false);
    }
  }, [linksBase, itemId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Debounced search of this project's items (excluding the current one).
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!adding) return;
    const q = query.trim();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResults([]);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(() => {
      void (async () => {
        try {
          const res = await jsonFetch<{ data: SearchRow[] }>(
            `/api/v1/orgs/${orgId}/work-items/search?project=${projectId}&text=${encodeURIComponent(q)}&pageSize=8`,
          );
          const linkedIds = new Set(
            links.flatMap((l) => [l.sourceItemId, l.targetItemId]),
          );
          setResults(
            (res.data ?? []).filter((r) => r.id !== itemId && !linkedIds.has(r.id)),
          );
        } catch {
          setResults([]);
        } finally {
          setSearching(false);
        }
      })();
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, adding, orgId, projectId, itemId, links]);

  async function createLink(targetItemId: string) {
    setCreating(true);
    try {
      await jsonFetch(linksBase, {
        method: "POST",
        body: JSON.stringify({ sourceItemId: itemId, targetItemId, type: relType }),
      });
      setQuery("");
      setResults([]);
      setAdding(false);
      await load();
    } catch (err) {
      notifyError(err, "Couldn't link the item.");
    } finally {
      setCreating(false);
    }
  }

  async function removeLink(id: string) {
    // Optimistic — drop it immediately, restore on failure.
    const prev = links;
    setLinks((ls) => ls.filter((l) => l.id !== id));
    try {
      await jsonFetch(`${linksBase}/${id}`, { method: "DELETE" });
    } catch (err) {
      setLinks(prev);
      notifyError(err, "Couldn't remove the link.");
    }
  }

  // Nothing to show and the actor can't add — render nothing (keeps the sheet
  // tidy for read-only viewers of items with no dependencies).
  if (!loading && links.length === 0 && !canEdit) return null;

  return (
    <>
      <Separator />
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Link2 className="h-3.5 w-3.5" />
            Linked items ({links.length})
          </h3>
          {canEdit && !adding && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
              Add link
            </button>
          )}
        </div>

        {loading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          links.map((l) => {
            const isSource = l.sourceItemId === itemId;
            const label = isSource ? FORWARD_LABEL[l.type] : INVERSE_LABEL[l.type];
            const otherId = isSource ? l.targetItemId : l.sourceItemId;
            const otherNumber = isSource ? l.targetTicketNumber : l.sourceTicketNumber;
            const otherTitle = isSource ? l.targetTitle : l.sourceTitle;
            return (
              <div key={l.id} className="group/link flex items-center gap-2 text-sm">
                <span className="w-24 shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
                  {label}
                </span>
                <button
                  type="button"
                  onClick={() => onOpenItem?.(otherId)}
                  disabled={!onOpenItem}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left enabled:hover:text-primary disabled:cursor-default"
                >
                  <span className="font-mono text-[11px] text-muted-foreground shrink-0">
                    #{otherNumber}
                  </span>
                  <span className="truncate">{otherTitle}</span>
                </button>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => removeLink(l.id)}
                    aria-label="Remove link"
                    className="shrink-0 text-muted-foreground opacity-100 hover:text-destructive sm:opacity-0 sm:group-hover/link:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            );
          })
        )}

        {canEdit && adding && (
          <div className="space-y-2 rounded-md border p-2">
            <div className="flex items-center gap-2">
              <Select
                items={Object.fromEntries(ADD_OPTIONS.map((o) => [o.value, o.label]))}
                value={relType}
                onValueChange={(v) => setRelType(v as LinkType)}
              >
                <SelectTrigger size="sm" aria-label="Link relationship" className="h-7 w-36 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ADD_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <button
                type="button"
                onClick={() => {
                  setAdding(false);
                  setQuery("");
                  setResults([]);
                }}
                aria-label="Cancel adding link"
                className="ml-auto text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="relative">
              <div className="flex items-center gap-1.5 rounded-md border px-2">
                <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <input
                  autoFocus
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search items to link…"
                  className="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
                {(searching || creating) && (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                )}
              </div>
              {results.length > 0 && (
                <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border bg-popover shadow-md">
                  {results.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        disabled={creating}
                        onClick={() => createLink(r.id)}
                        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50"
                      >
                        <span className="font-mono text-[11px] text-muted-foreground shrink-0">
                          {r.ticketKey}
                        </span>
                        <span className="truncate">{r.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {query.trim() && !searching && results.length === 0 && (
                <p className="mt-1 px-1 text-xs text-muted-foreground">
                  No matching items in this project.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
