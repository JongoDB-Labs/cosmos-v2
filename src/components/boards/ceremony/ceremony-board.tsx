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

  // Default to the sprint the team is actually in: the active one, else the most
  // recently completed, else the newest planned.
  const intervals = useMemo(() => intervalsQ.data ?? [], [intervalsQ.data]);
  const selectedId = useMemo(() => {
    if (intervalId) return intervalId;
    const active = intervals.find((i) => i.status === "ACTIVE");
    if (active) return active.id;
    const completed = [...intervals]
      .filter((i) => i.status === "COMPLETED")
      .sort((a, b) => b.number - a.number)[0];
    if (completed) return completed.id;
    return [...intervals].sort((a, b) => b.number - a.number)[0]?.id ?? null;
  }, [intervalId, intervals]);

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

  if (intervals.length === 0) {
    return (
      <EmptyState
        title="No sprints yet"
        description="A ceremony board reports on a sprint. Create one to run planning or a review."
      />
    );
  }

  if (ceremonyQ.isError) {
    return (
      <LoadError
        description="Could not load this ceremony."
        onRetry={() => void ceremonyQ.refetch()}
      />
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

  return (
    <div
      className={cn(
        "flex flex-col gap-4",
        presenting &&
          "fixed inset-0 z-50 overflow-auto bg-[var(--bg,var(--surface))] p-8"
      )}
    >
      {/* A classification banner is a legal marking, not decoration: if the
          board carries one it must be visible in presentation too. */}
      {classification ? (
        <p className="text-center text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">
          {classification}
        </p>
      ) : null}

      <header className="flex flex-wrap items-center gap-3">
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
              : "Not started"}
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

      <div
        role="tablist"
        aria-label="Ceremony section"
        className="flex flex-wrap gap-0.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-0.5"
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

      <div className="min-h-[300px]">
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
          <div className="space-y-4">
            <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
              <p className="text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                Next sprint window
              </p>
              <p className="mt-1 text-lg font-semibold">
                {data.nextSprint.name}
              </p>
              <p className="text-sm text-[var(--text-muted)]">
                {data.nextSprint.startDate} – {data.nextSprint.endDate}
              </p>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-semibold">
                Starting backlog — carried from {data.sprint.name}
              </h3>
              <CarriedList carried={data.carried} projectKey={projectKey} />
            </div>
          </div>
        ) : null}
      </div>

      {ceremony ? null : (
        <p className="text-xs text-[var(--text-muted)]">
          Start the ceremony to capture notes and action items. The figures above
          are live either way.
        </p>
      )}
    </div>
  );
}
