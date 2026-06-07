"use client";

import { KanbanBoard } from "@/components/boards/kanban/kanban-board";
import { TableView } from "@/components/boards/table/table-view";
import { CalendarView } from "@/components/boards/calendar/calendar-view";
import { TimelineView } from "@/components/boards/timeline/timeline-view";
import { DashboardView } from "@/components/boards/dashboard/dashboard-view";
import { CfdView } from "@/components/boards/cfd/cfd-view";
import { SprintBoard } from "@/components/boards/scrum/sprint-board";
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
 *   BACKLOG  → Table  (the ranked work-item list)
 *   RAID     → Table  (risks / assumptions / issues / dependencies log)
 *   ROADMAP  → Timeline
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
    case "BACKLOG":
    case "RAID":
      return <TableView {...viewProps} />;

    case "CALENDAR":
      return <CalendarView {...viewProps} />;

    case "TIMELINE":
    case "ROADMAP":
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
