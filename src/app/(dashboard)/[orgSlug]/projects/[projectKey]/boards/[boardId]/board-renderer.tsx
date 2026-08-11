"use client";

import type { ReactNode } from "react";
import type { BoardType } from "@prisma/client";
import { KanbanBoard } from "@/components/boards/kanban/kanban-board";
import { TableView } from "@/components/boards/table/table-view";
import { CalendarView } from "@/components/boards/calendar/calendar-view";
import { TimelineView } from "@/components/boards/timeline/timeline-view";
import { ReleaseTimelineView } from "@/components/boards/timeline/release-timeline-view";
import { RoadmapView } from "@/components/boards/roadmap/roadmap-view";
import { DashboardView } from "@/components/boards/dashboard/dashboard-view";
import { CfdView } from "@/components/boards/cfd/cfd-view";
import { SprintBoard } from "@/components/boards/scrum/sprint-board";
import { BacklogView } from "@/components/boards/backlog/backlog-view";
import { RaidView } from "@/components/boards/raid/raid-view";
import { OkrBoard } from "@/components/okrs/okr-board";
import { CeremonyBoard } from "@/components/boards/ceremony/ceremony-board";

export interface BoardViewProps {
  orgId: string;
  projectId: string;
  projectKey: string;
  boardId: string;
  /** Optional view variant from the board's config (e.g. TIMELINE →
   *  "release-timeline" static snapshot vs the interactive Gantt default). */
  viewMode?: string | null;
}

/** The props every view takes, without the variant most of them ignore. */
function core({ orgId, projectId, projectKey, boardId }: BoardViewProps) {
  return { orgId, projectId, projectKey, boardId };
}

/**
 * Maps a board's `type` to a view. Every type renders a functional view — there
 * are no "coming soon" stubs. Several gov/PM board types are expressed in terms
 * of the proven core views until a bespoke view ships:
 *   SCRUM    → Sprint board (active-sprint header + the Kanban scoped to it)
 *   BACKLOG  → ranked product backlog (re-rank + assign-to-sprint)
 *   RAID     → RAID log (risks/assumptions/issues/dependencies, grouped by tag)
 *   ROADMAP  → strategic Roadmap (epic swimlanes × increments, Jira-Plans style)
 *   TIMELINE → interactive Gantt by default; the static Release Timeline snapshot
 *              when config.mode === "release-timeline"
 *   PORTFOLIO/PROGRAM → Dashboard (rollup widgets)
 *   OKR      → the dedicated objectives/key-results board
 *
 * Typed as a total Record rather than a `switch` with a `default:`. The old
 * default returned the Kanban board, so a type added to the enum and forgotten
 * here rendered the WRONG board with no error — it looked like it worked. Now
 * omitting one fails the build.
 */
export const BOARD_VIEWS: Record<
  BoardType,
  (props: BoardViewProps) => ReactNode
> = {
  KANBAN: (p) => <KanbanBoard {...core(p)} />,
  TABLE: (p) => <TableView {...core(p)} />,
  BACKLOG: (p) => <BacklogView {...core(p)} />,
  RAID: (p) => <RaidView {...core(p)} />,
  CALENDAR: (p) => <CalendarView {...core(p)} />,
  ROADMAP: (p) => <RoadmapView {...core(p)} />,
  CFD: (p) => <CfdView {...core(p)} />,
  SCRUM: (p) => <SprintBoard {...core(p)} />,
  // Same board type, two variants: the static, read-only Release Timeline
  // snapshot (config.mode) vs the interactive Gantt (default).
  TIMELINE: (p) =>
    p.viewMode === "release-timeline" ? (
      <ReleaseTimelineView {...core(p)} />
    ) : (
      <TimelineView {...core(p)} />
    ),
  DASHBOARD: (p) => <DashboardView {...core(p)} />,
  PORTFOLIO: (p) => <DashboardView {...core(p)} />,
  PROGRAM: (p) => <DashboardView {...core(p)} />,
  OKR: (p) => <OkrBoard orgId={p.orgId} projectId={p.projectId} />,
  SPRINT_PLANNING: (p) => <CeremonyBoard {...core(p)} kind="PLANNING" />,
  SPRINT_REVIEW: (p) => <CeremonyBoard {...core(p)} kind="REVIEW" />,
};

interface BoardRendererProps extends BoardViewProps {
  boardType: BoardType;
}

export function BoardRenderer({ boardType, ...viewProps }: BoardRendererProps) {
  return <>{BOARD_VIEWS[boardType](viewProps)}</>;
}
