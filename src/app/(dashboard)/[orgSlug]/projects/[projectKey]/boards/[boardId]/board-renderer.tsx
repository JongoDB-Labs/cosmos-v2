"use client";

import { KanbanBoard } from "@/components/boards/kanban/kanban-board";
import { TableView } from "@/components/boards/table/table-view";
import { CalendarView } from "@/components/boards/calendar/calendar-view";
import { TimelineView } from "@/components/boards/timeline/timeline-view";
import { RoadmapView } from "@/components/boards/roadmap/roadmap-view";
import { DashboardView } from "@/components/boards/dashboard/dashboard-view";
import { CfdView } from "@/components/boards/cfd/cfd-view";
import { SprintBoard } from "@/components/boards/scrum/sprint-board";
import { BacklogView } from "@/components/boards/backlog/backlog-view";
import { RaidView } from "@/components/boards/raid/raid-view";
import { OkrBoard } from "@/components/okrs/okr-board";

interface BoardRendererProps {
  orgId: string;
  projectId: string;
  projectKey: string;
  boardId: string;
  boardType: string;
}

/**
 * Maps a board's `type` to a view. Every type renders a functional view — there
 * are no "coming soon" stubs. Several gov/PM board types are expressed in terms
 * of the proven core views until a bespoke view ships:
 *   SCRUM    → Sprint board (active-sprint header + the Kanban scoped to it)
 *   BACKLOG  → ranked product backlog (re-rank + assign-to-sprint)
 *   RAID     → RAID log (risks/assumptions/issues/dependencies, grouped by tag)
 *   ROADMAP  → strategic Roadmap (epic swimlanes × increments, Jira-Plans style)
 *   TIMELINE → interactive Gantt (date-driven bars + dependency arrows)
 *   PORTFOLIO/PROGRAM → Dashboard (rollup widgets)
 *   OKR      → the dedicated objectives/key-results board
 */
export function BoardRenderer({
  orgId,
  projectId,
  projectKey,
  boardId,
  boardType,
}: BoardRendererProps) {
  const viewProps = { orgId, projectId, projectKey, boardId };

  switch (boardType) {
    case "TABLE":
      return <TableView {...viewProps} />;

    case "BACKLOG":
      return <BacklogView {...viewProps} />;

    case "RAID":
      return <RaidView {...viewProps} />;

    case "CALENDAR":
      return <CalendarView {...viewProps} />;

    case "ROADMAP":
      return <RoadmapView {...viewProps} />;

    case "TIMELINE":
      return <TimelineView {...viewProps} />;

    case "DASHBOARD":
    case "PORTFOLIO":
    case "PROGRAM":
      return <DashboardView {...viewProps} />;

    case "CFD":
      return <CfdView {...viewProps} />;

    case "OKR":
      return <OkrBoard orgId={orgId} projectId={projectId} />;

    case "SCRUM":
      return <SprintBoard {...viewProps} />;

    case "KANBAN":
    default:
      return <KanbanBoard {...viewProps} />;
  }
}
