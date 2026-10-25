"use client";

import type { ReactElement } from "react";
import { PreviewCard } from "@base-ui/react/preview-card";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch, FetchError } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { kindLabel } from "@/lib/notifications/kind";
import type { IssueRow } from "@/lib/work-items/query/project";

/** What a preview needs of a notification; both the bell and the inbox have it. */
export type PreviewableNotification = {
  type: string;
  title: string;
  body: string;
  refType?: string | null;
  refId?: string | null;
  createdAt: string;
};

const exactly = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const humanize = (key: string) => {
  const words = key.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
};

/**
 * Hovering (or focusing) a notification shows more of it: the whole message
 * rather than two clipped lines, when it happened, and — for a work item — the
 * item as it stands now.
 *
 * The item is read through the same org-scoped row endpoint the Issues view
 * deep-links with, so the preview can show nothing the person couldn't open:
 * an item outside their readable projects is a 404 there, and a 404 here.
 * Nothing is fetched until a preview actually opens.
 */
export function NotificationPreview({
  orgId,
  notification,
  side = "left",
  children,
}: {
  orgId: string;
  notification: PreviewableNotification;
  side?: "left" | "right" | "top" | "bottom";
  /** The row. Rendered as the hover target, so it must accept a ref and props. */
  children: ReactElement;
}) {
  return (
    <PreviewCard.Root>
      <PreviewCard.Trigger render={children} delay={500} closeDelay={150} />
      <PreviewCard.Portal>
        <PreviewCard.Positioner
          side={side}
          sideOffset={8}
          align="start"
          className="z-50"
        >
          <PreviewCard.Popup
            className="w-72 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-3 text-sm shadow-lg"
            data-testid="notification-preview"
          >
            <PreviewBody orgId={orgId} n={notification} />
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}

function PreviewBody({
  orgId,
  n,
}: {
  orgId: string;
  n: PreviewableNotification;
}) {
  const itemId = n.refType === "work_item" && n.refId ? n.refId : null;
  return (
    <div className="space-y-2">
      <p className="text-xs text-[var(--text-muted)]">
        {kindLabel(n.type)} · {exactly(n.createdAt)}
      </p>
      <p className="font-medium">{n.title}</p>
      {n.body && (
        <p className="whitespace-pre-wrap text-[var(--text-muted)]">{n.body}</p>
      )}
      {itemId && <ItemContext orgId={orgId} itemId={itemId} />}
    </div>
  );
}

function ItemContext({ orgId, itemId }: { orgId: string; itemId: string }) {
  const key = useOrgQueryKey("notification-preview", "work-item", itemId);
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      jsonFetch<IssueRow>(`/api/v1/orgs/${orgId}/work-items/${itemId}/row`),
    staleTime: 30_000,
    retry: false,
  });

  if (q.isPending) {
    return (
      <p className="border-t border-[var(--border)] pt-2 text-xs text-[var(--text-muted)]">
        Loading the item…
      </p>
    );
  }
  if (q.isError) {
    const gone = q.error instanceof FetchError && q.error.status === 404;
    return (
      <p className="border-t border-[var(--border)] pt-2 text-xs text-[var(--text-muted)]">
        {gone
          ? "You can’t see this item, or it has been deleted."
          : "Couldn’t load the item."}
      </p>
    );
  }
  const item = q.data;
  const people = item.assignees.length
    ? item.assignees.map((a) => a.displayName).join(", ")
    : "Unassigned";
  return (
    <div
      className="space-y-1 border-t border-[var(--border)] pt-2"
      aria-label="Item now"
    >
      <p className="text-xs text-[var(--text-muted)]">
        {item.ticketKey} · {item.type.name}
        {item.archivedAt ? " · Archived" : ""}
      </p>
      <p className="font-medium">{item.title}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-[var(--text-muted)]">Status</dt>
        <dd>{humanize(item.columnKey)}</dd>
        <dt className="text-[var(--text-muted)]">Priority</dt>
        <dd>{humanize(item.priority)}</dd>
        <dt className="text-[var(--text-muted)]">Assignee</dt>
        <dd>{people}</dd>
        {item.dueDate && (
          <>
            <dt className="text-[var(--text-muted)]">Due</dt>
            <dd>{new Date(item.dueDate).toLocaleDateString()}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
