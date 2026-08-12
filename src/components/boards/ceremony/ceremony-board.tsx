"use client";

import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Play, Lock, Presentation, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import { EmptyState } from "@/components/ui/empty-state";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { cn } from "@/lib/utils";
import { formatDateMediumStable as fmtDay } from "@/lib/format/stable-date";
import {
  ceremonySelectableIntervals,
  defaultCeremonyInterval,
} from "@/lib/intervals/ceremony-intervals";
import { useCeremony } from "./use-ceremony";
import { CeremonySummary } from "./ceremony-summary";
import { ShippedList, CarriedList } from "./item-lists";
import { RetroColumns } from "./retro-columns";
import { ActionItems } from "./action-items";
import { CapacityPanel } from "./capacity-panel";

interface CeremonyBoardProps {
  orgId: string;
  projectId: string;
  projectKey: string;
  boardId: string;
  kind: "PLANNING" | "REVIEW";
}

interface IntervalOption {
  id: string;
  name: string;
  number: number;
  status: "PLANNED" | "ACTIVE" | "COMPLETED";
  /** Needed to keep Program Increments out of a SPRINT ceremony's picker. */
  intervalKind: string;
}

interface OrgMemberLite {
  userId: string;
  displayName: string;
}

type TabKey = "summary" | "shipped" | "carried" | "retro" | "actions" | "next";

/**
 * A sprint ceremony as one page with tabs, not several routes.
 *
 * A facilitator switches between sections constantly during a live ceremony,
 * and navigating away loses scroll position and refetches the whole board every
 * time — which is exactly the wrong behaviour with a team watching.
 */
export function CeremonyBoard({
  orgId,
  projectId,
  projectKey,
  boardId,
  kind,
}: CeremonyBoardProps) {
  const basePathProject = `/api/v1/orgs/${orgId}/projects/${projectId}`;
  const orgSlug = (useParams().orgSlug as string) ?? "";
  const [intervalId, setIntervalId] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("summary");
  const [presenting, setPresenting] = useState(false);

  const intervalsKey = useOrgQueryKey("intervals", projectId);
  const intervalsQ = useQuery({
    queryKey: intervalsKey,
    queryFn: () =>
      jsonFetch<IntervalOption[]>(`${basePathProject}/intervals`),
  });

  const membersKey = useOrgQueryKey("members");
  const membersQ = useQuery({
    queryKey: membersKey,
    queryFn: () => jsonFetch<OrgMemberLite[]>(`/api/v1/orgs/${orgId}/members`),
  });

  // A ceremony reports on an ITERATION, so Program Increments are filtered out
  // of both the picker and the default — see ceremony-intervals for why the old
  // "first ACTIVE" rule landed on the PI nearly every time.
  const intervals = useMemo(
    () => ceremonySelectableIntervals(intervalsQ.data ?? []),
    [intervalsQ.data]
  );
  const selectedId = useMemo(
    () => intervalId ?? defaultCeremonyInterval(intervals)?.id ?? null,
    [intervalId, intervals]
  );

  const ceremonyQ = useCeremony({
    orgId,
    projectId,
    intervalId: selectedId,
    boardId,
  });
  // useOrgMutation expects the same PARTS you'd give useOrgQueryKey — it adds
  // the org prefix itself. Passing an already-prefixed key double-prefixes it,
  // which matches no query, so nothing invalidates and the board only recovers
  // on the realtime round-trip.
  const ceremonyParts = useMemo(
    () => ["ceremony", boardId, selectedId ?? "none"],
    [boardId, selectedId]
  );
  const basePath = `${basePathProject}/intervals/${selectedId}`;

  const openCeremony = useOrgMutation<unknown, Error, void>({
    mutationFn: () =>
      jsonFetch(`${basePath}/ceremony/open`, {
        method: "POST",
        body: JSON.stringify({ boardId, kind }),
      }),
    invalidate: [ceremonyParts],
  });

  const closeCeremony = useOrgMutation<unknown, Error, string>({
    mutationFn: (ceremonyId) =>
      jsonFetch(`${basePath}/ceremony/close`, {
        method: "POST",
        body: JSON.stringify({ ceremonyId }),
      }),
    invalidate: [ceremonyParts],
  });

  if (intervalsQ.isLoading || ceremonyQ.isLoading) {
    return (
      <div className="space-y-4 p-4">
        <Skeleton className="h-10 w-64" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      </div>
    );
  }

  // Both of these used to render flush into the top-left corner. `EmptyState` and
  // `LoadError` expect the caller to place them — every other board centres them
  // in the remaining height.
  if (intervals.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <EmptyState
          title="No sprints yet"
          description="A ceremony board reports on a sprint. Create one to run planning or a review."
        />
      </div>
    );
  }

  if (ceremonyQ.isError) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <LoadError
          description="Could not load this ceremony."
          onRetry={() => void ceremonyQ.refetch()}
        />
      </div>
    );
  }

  const data = ceremonyQ.data;
  if (!data) return null;

  const ceremony = data.ceremony;
  const closed = ceremony?.status === "CLOSED";
  const classification = data.board.config?.classification;

  const tabs: { key: TabKey; label: string }[] =
    kind === "REVIEW"
      ? [
          { key: "summary", label: "Summary" },
          { key: "shipped", label: "What shipped" },
          { key: "carried", label: "Carrying forward" },
          { key: "retro", label: "Retrospective" },
          { key: "actions", label: "Action items" },
          { key: "next", label: "Next sprint" },
        ]
      : [
          { key: "summary", label: "Summary" },
          { key: "carried", label: "Capacity" },
          { key: "retro", label: "Notes" },
          { key: "actions", label: "Action items" },
        ];

  // Every other surface on this page — the project header, the board tab strip —
  // is inset by `px-4`, and the board area itself is handed to us with no padding
  // at all. This board used to render at x=0, so its title sat 16px left of the
  // tabs directly above it and its cards ran flush into the sidebar.
  const gutter = presenting ? "px-10" : "px-4";
  // ONE reading width, for the chrome as well as the content. Capping only the
  // content left the sprint selector and Start button stretched to the full
  // viewport while the cards below them stopped ~700px short on a wide monitor.
  const measure = presenting ? "" : "max-w-[1600px]";

  return (
    <div
      className={cn(
        "flex h-full flex-col",
        // Present mode is for a ROOM, not a desk. Going full-bleed was not
        // enough: it rendered at the same type sizes as the normal view, so the
        // headline figures a team is meant to read from across a room were
        // ~20px. `text-[1.35rem]` on the container scales every rem-based size
        // inside it at once — including the stat figures — rather than needing a
        // presentation variant threaded through each panel.
        presenting &&
          "fixed inset-0 z-50 bg-[var(--bg,var(--surface))] text-[1.35rem] [&_h2]:text-[1.6em] [&_h3]:text-[1.2em]"
      )}
    >
      {/* A classification banner is a legal marking, not decoration: if the
          board carries one it must be visible in presentation too. */}
      {classification ? (
        <p
          className={cn(
            "shrink-0 border-b border-[var(--border)] py-2 text-center text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]",
            gutter
          )}
        >
          {classification}
        </p>
      ) : null}

      {/* Title, controls and section tabs are one block of chrome — together they
          answer "which ceremony am I looking at". A rule under them separates the
          controls from the report, the way every other board here does it, and
          keeps them in place while the report scrolls under a facilitator. */}
      <div
        className={cn(
          "shrink-0 space-y-3 border-b border-[var(--border)] py-3",
          gutter
        )}
      >
        <div className={cn("space-y-3", measure)}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold">
            {data.board.name} — {data.sprint.name}
          </h2>
          <p className="text-xs text-[var(--text-muted)]">
            {ceremony
              ? closed
                ? `Closed ${
                    ceremony.closedAt
                      ? new Date(ceremony.closedAt).toLocaleString()
                      : ""
                  }`
                : "In progress"
              : // Sat as a footnote below the panels, which on a short tab left it
                // stranded in whitespace. It explains the state, so it belongs with
                // the state.
                "Not started — start the ceremony to capture notes and actions. The figures are live either way."}
          </p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label htmlFor="ceremony-sprint" className="sr-only">
            Sprint
          </label>
          <select
            id="ceremony-sprint"
            value={selectedId ?? ""}
            onChange={(e) => setIntervalId(e.target.value)}
            className="h-9 rounded-[calc(var(--radius)-2px)] border border-[var(--border)] bg-[var(--surface)] px-2 text-sm"
          >
            {intervals.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>

          {!ceremony || closed ? (
            <Button
              size="sm"
              onClick={() => openCeremony.mutate()}
              disabled={openCeremony.isPending}
            >
              <Play className="mr-1 h-3.5 w-3.5" />
              {closed ? "Reopen" : "Start ceremony"}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => closeCeremony.mutate(ceremony.id)}
              disabled={closeCeremony.isPending}
            >
              <Lock className="mr-1 h-3.5 w-3.5" />
              Close
            </Button>
          )}

          <Button
            size="sm"
            variant="outline"
            aria-label={presenting ? "Exit presentation" : "Present"}
            onClick={() => setPresenting((p) => !p)}
          >
            {presenting ? (
              <X className="h-3.5 w-3.5" />
            ) : (
              <Presentation className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </header>

      {/* `w-fit` so the segmented control hugs its six short tabs. Stretched to
          the full width it read as an empty toolbar with buttons crammed at one
          end, rather than as a set of choices. */}
      <div
        role="tablist"
        aria-label="Ceremony section"
        className="flex w-fit max-w-full flex-wrap gap-0.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-0.5"
      >
        {tabs.map((t) => {
          const active = t.key === tab;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.key)}
              className={cn(
                "rounded-[calc(var(--radius)-2px)] px-3 py-1.5 text-sm font-medium transition-colors",
                active
                  ? "bg-[var(--primary)] text-[var(--primary-foreground,#fff)]"
                  : "text-[var(--text-muted)] hover:text-[var(--text)]"
              )}
            >
              {t.label}
            </button>
          );
        })}
        </div>
        </div>
      </div>

      {/* The report scrolls, the chrome above it does not. `py-6` rather than the
          `gap-4` this used to inherit: the tab strip and the first row of cards
          were 16px apart, which read as one block instead of a control and the
          thing it controls. */}
      <div className={cn("flex-1 overflow-y-auto py-6", gutter)}>
        <div className={cn("w-full", measure)}>
        {tab === "summary" ? <CeremonySummary data={data} /> : null}

        {tab === "shipped" ? (
          <ShippedList
            items={data.shipped}
            projectKey={projectKey}
            totalPoints={data.metrics.completedPoints}
          />
        ) : null}

        {tab === "carried" && kind === "REVIEW" ? (
          <CarriedList carried={data.carried} projectKey={projectKey} />
        ) : null}

        {tab === "carried" && kind === "PLANNING" ? (
          <CapacityPanel
            orgId={orgId}
            projectId={projectId}
            intervalId={selectedId!}
          />
        ) : null}

        {tab === "retro" ? (
          <RetroColumns
            basePath={basePath}
            ceremonyId={ceremony?.id ?? null}
            columns={data.columns}
            notes={ceremony?.notes ?? []}
            closed={closed}
            invalidateParts={ceremonyParts}
          />
        ) : null}

        {tab === "actions" ? (
          <ActionItems
            basePath={basePath}
            projectKey={projectKey}
            orgSlug={orgSlug}
            ceremonyId={ceremony?.id ?? null}
            actions={ceremony?.actionItems ?? []}
            members={membersQ.data ?? []}
            closed={closed}
            invalidateParts={ceremonyParts}
          />
        ) : null}

        {tab === "next" ? (
          // Two columns, like the outbrief slide this replaces: the increment's
          // facts on the left, what actually rolls into it on the right. As one
          // stacked column the window card stretched the full viewport to hold
          // three short lines, and the list sat under it unframed.
          <div className="grid gap-4 lg:grid-cols-[minmax(260px,340px)_1fr]">
            <dl className="h-fit space-y-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  Next sprint
                </dt>
                <dd className="mt-1 text-xl font-semibold">{data.nextSprint.name}</dd>
                <dd className="mt-0.5 text-sm text-[var(--text-muted)]">
                  {fmtDay(data.nextSprint.startDate)} – {fmtDay(data.nextSprint.endDate)}
                </dd>
              </div>
              {data.increment ? (
                <div className="border-t border-[var(--border)] pt-4">
                  <dt className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                    Increment
                  </dt>
                  <dd className="mt-1 text-sm font-medium">{data.increment.name}</dd>
                </div>
              ) : null}
              <div className="border-t border-[var(--border)] pt-4">
                <dt className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  Carry-in
                </dt>
                <dd className="mt-1 text-sm font-medium">
                  {data.carried.kind === "unrecorded"
                    ? "Not recorded"
                    : `${data.carried.items.length} from ${data.sprint.name}`}
                </dd>
              </div>
            </dl>

            <section className="rounded-[var(--radius)] border border-[var(--border)] p-5">
              <h3 className="mb-3 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                Starting backlog — carried from {data.sprint.name}
              </h3>
              <CarriedList carried={data.carried} projectKey={projectKey} />
            </section>
          </div>
        ) : null}
        </div>
      </div>
    </div>
  );
}
