"use client";

import { KanbanBoard } from "@/components/boards/kanban/kanban-board";
import { TableView } from "@/components/boards/table/table-view";
import { CalendarView } from "@/components/boards/calendar/calendar-view";
import { TimelineView } from "@/components/boards/timeline/timeline-view";
import { DashboardView } from "@/components/boards/dashboard/dashboard-view";
import { CfdView } from "@/components/boards/cfd/cfd-view";
import { LayoutGrid } from "lucide-react";

interface BoardRendererProps {
  orgId: string;
  projectId: string;
  projectKey: string;
  boardId: string;
  boardType: string;
}

const COMING_SOON_TYPES = [
  "SCRUM",
  "BACKLOG",
  "OKR",
  "PORTFOLIO",
  "RAID",
  "ROADMAP",
  "PROGRAM",
];

export function BoardRenderer({
  orgId,
  projectId,
  projectKey,
  boardId,
  boardType,
}: BoardRendererProps) {
  switch (boardType) {
    case "KANBAN":
      return (
        <KanbanBoard
          orgId={orgId}
          projectId={projectId}
          projectKey={projectKey}
          boardId={boardId}
        />
      );

    case "TABLE":
      return (
        <TableView
          orgId={orgId}
          projectId={projectId}
          projectKey={projectKey}
          boardId={boardId}
        />
      );

    case "CALENDAR":
      return (
        <CalendarView
          orgId={orgId}
          projectId={projectId}
          projectKey={projectKey}
          boardId={boardId}
        />
      );

    case "TIMELINE":
      return (
        <TimelineView
          orgId={orgId}
          projectId={projectId}
          projectKey={projectKey}
          boardId={boardId}
        />
      );

    case "DASHBOARD":
      return (
        <DashboardView
          orgId={orgId}
          projectId={projectId}
          projectKey={projectKey}
          boardId={boardId}
        />
      );

    case "CFD":
      return (
        <CfdView
          orgId={orgId}
          projectId={projectId}
          projectKey={projectKey}
          boardId={boardId}
        />
      );

    default:
      if (COMING_SOON_TYPES.includes(boardType)) {
        return (
          <div className="flex flex-col items-center justify-center h-64 gap-3">
            <LayoutGrid className="h-10 w-10 text-muted-foreground/50" />
            <div className="text-center">
              <p className="text-sm font-medium text-muted-foreground">
                {boardType.charAt(0) + boardType.slice(1).toLowerCase()} View
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Coming soon
              </p>
            </div>
          </div>
        );
      }

      return (
        <KanbanBoard
          orgId={orgId}
          projectId={projectId}
          projectKey={projectKey}
          boardId={boardId}
        />
      );
  }
}
