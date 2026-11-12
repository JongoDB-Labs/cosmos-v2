"use client";

/**
 * The content widgets that hold no project data of their own: a list of links
 * the author typed, and a button that opens the New work item form.
 */
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useOrgQueryKey } from "@/lib/query/keys";
import type { WidgetProps } from "@/lib/boards/widget-registry";
import { widgetConfigText, widgetLinks } from "@/lib/boards/widget-data";
import { NewWorkItemButton } from "@/components/boards/shared/new-work-item-button";
import { NoData } from "./widget-parts";

// ── link-list ────────────────────────────────────────────────────────────────

export function LinkListWidget(props: WidgetProps) {
  // `widgetLinks` keeps only http(s) URLs and in-app paths that provably stay
  // in the app (`widget-links.ts`): the text is typed by one person onto a
  // board everyone opens. In-app paths are resolved against the viewer's own
  // origin; the verdict and the href are the same without one (the server
  // render), so nothing differs at hydration.
  const origin = typeof window === "undefined" ? undefined : window.location.origin;
  const links = widgetLinks(props.config, origin);
  if (links.length === 0) return <NoData>No links added yet</NoData>;
  return (
    <ul className="h-full space-y-0.5 overflow-auto text-sm">
      {links.map((l, i) => (
        <li key={`${i}-${l.href}`}>
          {l.external ? (
            <a
              href={l.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[var(--primary)] hover:underline"
            >
              {l.label}
              <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          ) : (
            <Link
              href={l.href}
              className="inline-block rounded px-1 py-0.5 text-[var(--primary)] hover:underline"
            >
              {l.label}
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}

// ── quick-action ─────────────────────────────────────────────────────────────

export function QuickActionWidget(props: WidgetProps) {
  const label = widgetConfigText(props.config, "label", "New work item");
  const qc = useQueryClient();
  const itemsKey = useOrgQueryKey("work-items", props.projectId ?? "");
  // The builder's preview mounts widgets with no board data and, on a board
  // without a project, no project to file into: draw what the button will say
  // rather than a button that cannot work.
  if (!props.data || !props.projectId || !props.data.projectKey) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="rounded-md border border-dashed px-3 py-1.5 text-xs text-muted-foreground">
          {label}
        </span>
      </div>
    );
  }
  return (
    <div className="flex h-full items-center justify-center">
      {/* The SAME create dialog every other board uses, so the fields, the
          type picker and the server's create permission all apply unchanged. */}
      <NewWorkItemButton
        orgId={props.orgId}
        projectId={props.projectId}
        projectKey={props.data.projectKey}
        boardId={props.boardId}
        label={label}
        variant="default"
        onCreated={() => qc.invalidateQueries({ queryKey: itemsKey })}
      />
    </div>
  );
}
