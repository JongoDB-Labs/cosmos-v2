"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExternalLink, Star } from "lucide-react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export interface IssueDetailRow {
  id: string;
  ticketKey: string;
  title: string;
  columnKey: string;
  priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  type: { name: string; icon: string | null };
  project: { id: string; key: string; name: string };
  assignee: { id: string; displayName: string; avatarUrl: string | null } | null;
  parent: { id: string; ticketKey: string; title: string } | null;
  storyPoints: number | null;
  tags: string[];
  startDate: string | null;
  dueDate: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const PRIORITY_VARIANT: Record<IssueDetailRow["priority"], BadgeVariant> = {
  CRITICAL: "critical",
  HIGH: "blocked",
  MEDIUM: "review",
  LOW: "neutral",
};

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  TODO: "neutral",
  IN_PROGRESS: "progress",
  DONE: "done",
};

function fmtDate(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
        {label}
      </dt>
      <dd className="text-sm text-[var(--text)]">{children}</dd>
    </div>
  );
}

/**
 * Read-focused detail for a work item, opened from the cross-project Issues
 * list (so it deliberately does NOT need the board's per-project columns/intervals
 * context). Shows everything in the search row plus the full description
 * (fetched on open), with "Open in board" for full editing.
 */
export function IssueDetailSheet({
  row,
  open,
  onOpenChange,
  orgId,
  orgSlug,
  statuses,
}: {
  row: IssueDetailRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  orgSlug: string;
  statuses: { key: string; name: string; category: string }[];
}) {
  const [description, setDescription] = useState<string | null>(null);
  const [loadingDesc, setLoadingDesc] = useState(false);
  // Watch state (FR 8702c9b8).
  const [watching, setWatching] = useState(false);
  const [watchPending, setWatchPending] = useState(false);
  // Once the user toggles, ignore a late in-flight on-open GET so it can't
  // clobber their action.
  const watchTouched = useRef(false);

  useEffect(() => {
    if (!open || !row) return;
    watchTouched.current = false;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/v1/orgs/${orgId}/projects/${row.project.id}/work-items/${row.id}/watch`,
        );
        if (!cancelled && !watchTouched.current && res.ok) {
          const d = (await res.json()) as { watching: boolean };
          setWatching(d.watching);
        }
      } catch {
        /* non-critical */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, row, orgId]);

  async function toggleWatch() {
    if (!row || watchPending) return;
    watchTouched.current = true;
    const next = !watching;
    setWatching(next);
    setWatchPending(true);
    try {
      const res = await fetch(
        `/api/v1/orgs/${orgId}/projects/${row.project.id}/work-items/${row.id}/watch`,
        { method: next ? "POST" : "DELETE" },
      );
      if (!res.ok) throw new Error("failed");
    } catch {
      setWatching(!next);
    } finally {
      setWatchPending(false);
    }
  }

  // Fetch the description (not carried in the lightweight search row) on open.
  useEffect(() => {
    if (!open || !row) return;
    let cancelled = false;
    // Reset + show loading when (re)opening for a new row — synchronous resets
    // on an external trigger (the established fetch-on-open pattern); scope-disable.
    /* eslint-disable react-hooks/set-state-in-effect */
    setDescription(null);
    setLoadingDesc(true);
    /* eslint-enable react-hooks/set-state-in-effect */
    (async () => {
      try {
        const res = await fetch(
          `/api/v1/orgs/${orgId}/projects/${row.project.id}/work-items/${row.id}`,
        );
        if (!res.ok) return;
        const json = await res.json();
        const item = json?.data ?? json;
        if (!cancelled) setDescription(typeof item?.description === "string" ? item.description : "");
      } catch {
        /* description is best-effort */
      } finally {
        if (!cancelled) setLoadingDesc(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, row, orgId]);

  if (!row) return null;

  const status = statuses.find((s) => s.key === row.columnKey);
  const statusVariant = status ? STATUS_VARIANT[status.category] ?? "neutral" : "neutral";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] p-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
              <span className="font-mono">{row.ticketKey}</span>
              <span className="inline-flex items-center gap-1">
                {row.type.icon && <span aria-hidden>{row.type.icon}</span>}
                {row.type.name}
              </span>
            </div>
            <h2 className="mt-1 text-lg font-semibold leading-snug text-[var(--text)]">
              {row.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => void toggleWatch()}
            disabled={watchPending}
            aria-pressed={watching}
            aria-label={watching ? "Unwatch this item" : "Watch this item"}
            title={watching ? "You're watching this item" : "Watch this item to track it"}
            className={cn(
              // mr-7 clears the Sheet's absolute close (X) button in the corner.
              "mr-7 shrink-0 rounded-md p-1.5 transition-colors hover:bg-[var(--muted)]/50",
              watching ? "text-amber-500" : "text-[var(--text-muted)]",
            )}
          >
            <Star className={cn("h-4 w-4", watching && "fill-current")} />
          </button>
        </div>

        {/* Vertical scroll only: without an explicit overflow-x, `overflow-y-auto`
            promotes overflow-x to `auto` (CSS spec), so any wide descendant (a
            markdown table, code block, or long unbreakable token in the
            description) makes the WHOLE pane — metadata grid included — jerk
            sideways. Pin overflow-x here and let wide content scroll inside its
            own block below. */}
        <div data-testid="issue-detail-body" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-4">
          <div className="mb-4 flex flex-wrap gap-2">
            <Badge variant={statusVariant}>{status?.name ?? row.columnKey}</Badge>
            <Badge variant={PRIORITY_VARIANT[row.priority]}>{row.priority}</Badge>
          </div>

          <dl className="grid grid-cols-2 gap-4">
            <Field label="Project">
              <Badge variant="neutral">{row.project.key}</Badge>
            </Field>
            <Field label="Assignee">
              {row.assignee ? (
                <span className="inline-flex items-center gap-2">
                  <Avatar className="h-5 w-5">
                    <AvatarImage src={row.assignee.avatarUrl ?? undefined} />
                    <AvatarFallback className="text-[9px]">
                      {row.assignee.displayName.slice(0, 2).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  {row.assignee.displayName}
                </span>
              ) : (
                <span className="text-[var(--text-muted)]">Unassigned</span>
              )}
            </Field>
            <Field label="Story points">{row.storyPoints ?? "—"}</Field>
            <Field label="Parent">
              {row.parent ? (
                <span className="font-mono text-xs">{row.parent.ticketKey}</span>
              ) : (
                "—"
              )}
            </Field>
            <Field label="Start">{fmtDate(row.startDate)}</Field>
            <Field label="Due">{fmtDate(row.dueDate)}</Field>
            <Field label="Created">{fmtDate(row.createdAt)}</Field>
            <Field label="Updated">{fmtDate(row.updatedAt)}</Field>
          </dl>

          {row.tags.length > 0 && (
            <div className="mt-4">
              <dt className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
                Labels
              </dt>
              <div className="flex flex-wrap gap-1.5">
                {row.tags.map((t) => (
                  <Badge key={t} variant="neutral">{t}</Badge>
                ))}
              </div>
            </div>
          )}

          <div className="mt-5">
            <dt className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
              Description
            </dt>
            {loadingDesc ? (
              <Skeleton className="h-16 w-full rounded-md" />
            ) : description ? (
              // `overflow-x-auto` keeps wide markdown content reachable: prose
              // text still wraps (break-words), but a GFM table or fenced code
              // block that can't wrap gets a horizontal scrollbar WITHIN this
              // block instead of being clipped by the pane.
              <div
                data-testid="issue-detail-description"
                className="prose prose-sm dark:prose-invert max-w-none overflow-x-auto break-words"
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{description}</ReactMarkdown>
              </div>
            ) : (
              <p className="text-sm text-[var(--text-muted)]">No description.</p>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] p-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Link
            href={`/${orgSlug}/projects/${row.project.key}`}
            className={cn(buttonVariants(), "gap-1.5")}
          >
            Open in board
            <ExternalLink className="h-4 w-4" />
          </Link>
        </div>
      </SheetContent>
    </Sheet>
  );
}
