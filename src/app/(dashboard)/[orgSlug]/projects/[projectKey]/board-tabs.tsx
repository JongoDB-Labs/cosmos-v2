"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Plus, Users, Trash2, Star } from "lucide-react";
import { ActionMenu, type ActionMenuGroup } from "@/components/ui/action-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { notifyError } from "@/lib/errors/notify";
import { toast } from "sonner";

interface BoardTab {
  id: string;
  name: string;
  type: string;
}

interface ProjectBoardTabsProps {
  orgSlug: string;
  projectKey: string;
  orgId: string;
  projectId: string;
  boards: BoardTab[];
  enabledFeatures?: string[];
  /** Whether the actor may delete boards (org BOARD_DELETE or project MANAGER). */
  canManageBoards?: boolean;
  /** Whether the actor may create boards (org BOARD_CREATE or project MANAGER). */
  canCreateBoards?: boolean;
  /** The project's current default board (everyone lands here) — from
   *  Project.settings.defaultBoardId. Managers can change it from a board's menu. */
  defaultBoardId?: string | null;
  templateDefaultConfig?: Record<string, unknown> | null;
}

interface FeatureTab {
  feature: string;
  label: string;
  href: string;
}

export function ProjectBoardTabs({
  orgSlug,
  projectKey,
  orgId,
  projectId,
  boards,
  enabledFeatures = [],
  canManageBoards = false,
  canCreateBoards = false,
  defaultBoardId = null,
  templateDefaultConfig,
}: ProjectBoardTabsProps) {
  const pathname = usePathname();
  const router = useRouter();

  const [boardToDelete, setBoardToDelete] = useState<BoardTab | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [settingDefault, setSettingDefault] = useState(false);

  // FR "Default view": a manager picks the board everyone lands on. Persisted in
  // Project.settings.defaultBoardId (merged server-side) and honored by the
  // project page's redirect.
  async function handleSetDefault(board: BoardTab) {
    setSettingDefault(true);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/projects/${projectId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { defaultBoardId: board.id } }),
      });
      if (!res.ok) throw new Error(`Failed (HTTP ${res.status})`);
      toast.success(`"${board.name}" is now the default board.`);
      router.refresh();
    } catch (err) {
      notifyError(err, "Couldn't set the default board.");
    } finally {
      setSettingDefault(false);
    }
  }

  const newBoardHref = `/${orgSlug}/projects/${projectKey}/boards/new`;

  // Derive cycle nav label from template config, fallback to "Sprints"
  const cycleNavLabel =
    typeof templateDefaultConfig?.cycleNavLabel === "string"
      ? templateDefaultConfig.cycleNavLabel
      : "Sprints";

  async function handleDeleteBoard() {
    const board = boardToDelete;
    if (!board) return;
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/v1/orgs/${orgId}/projects/${projectId}/boards/${board.id}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(`Failed to delete board (HTTP ${res.status})`);
      toast.success(`Deleted "${board.name}".`);
      setBoardToDelete(null);
      // If we just deleted the board we're viewing, move to another board (or the
      // project root); otherwise just refresh the tab list.
      const deletedHref = `/${orgSlug}/projects/${projectKey}/boards/${board.id}`;
      if (pathname === deletedHref) {
        const next = boards.find((b) => b.id !== board.id);
        router.push(
          next
            ? `/${orgSlug}/projects/${projectKey}/boards/${next.id}`
            : `/${orgSlug}/projects/${projectKey}`,
        );
      }
      router.refresh();
    } catch (err) {
      notifyError(err, "Couldn't delete the board.");
    } finally {
      setDeleting(false);
    }
  }

  // Build feature tabs based on enabledFeatures
  const featureTabs: FeatureTab[] = [];

  if (enabledFeatures.includes("okr")) {
    featureTabs.push({
      feature: "okr",
      label: "OKRs",
      href: `/${orgSlug}/projects/${projectKey}/okrs`,
    });
  }

  if (enabledFeatures.includes("goal")) {
    featureTabs.push({
      feature: "goal",
      label: "Goals",
      href: `/${orgSlug}/projects/${projectKey}/goals`,
    });
  }

  if (enabledFeatures.includes("kpi")) {
    featureTabs.push({
      feature: "kpi",
      label: "KPIs",
      href: `/${orgSlug}/projects/${projectKey}/kpis`,
    });
  }

  if (enabledFeatures.includes("milestone")) {
    featureTabs.push({
      feature: "milestone",
      label: "Milestones",
      href: `/${orgSlug}/projects/${projectKey}/milestones`,
    });
  }

  const membersHref = `/${orgSlug}/projects/${projectKey}/members`;

  return (
    <div className="flex items-center gap-1 px-4 border-b overflow-x-auto">
      {boards.map((board) => {
        const href = `/${orgSlug}/projects/${projectKey}/boards/${board.id}`;
        const isActive = pathname === href;

        const isDefault = board.id === defaultBoardId;
        const tab = (
          <Link
            href={href}
            className={cn(
              "relative flex items-center gap-1 px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap",
              isActive
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {isDefault && (
              <Star
                className="h-3 w-3 shrink-0 fill-primary text-primary"
                aria-label="Default board"
              />
            )}
            {board.name}
            {isActive && (
              <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary rounded-full" />
            )}
          </Link>
        );

        // A board manager gets a ⋯ / right-click menu on each tab: set-as-default
        // + delete.
        if (!canManageBoards) return <span key={board.id}>{tab}</span>;
        const groups: ActionMenuGroup[] = [
          {
            items: [
              ...(isDefault
                ? []
                : [
                    {
                      label: "Set as default board",
                      icon: Star,
                      disabled: settingDefault,
                      onClick: () => handleSetDefault(board),
                    },
                  ]),
            ],
          },
          {
            items: [
              {
                label: "Delete board",
                icon: Trash2,
                variant: "destructive" as const,
                onClick: () => setBoardToDelete(board),
              },
            ],
          },
        ];
        return (
          <div key={board.id} className="group/action relative flex items-center">
            <ActionMenu groups={groups} triggerLabel={`Board actions for ${board.name}`}>
              {tab}
            </ActionMenu>
          </div>
        );
      })}

      {featureTabs.map((tab) => {
        const isActive = pathname === tab.href;

        return (
          <Link
            key={tab.feature}
            href={tab.href}
            className={cn(
              "relative px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap",
              isActive
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
            {isActive && (
              <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary rounded-full" />
            )}
          </Link>
        );
      })}

      {/* Cycles tab — label driven by template config */}
      {enabledFeatures.includes("cycle") && (() => {
        const cyclesHref = `/${orgSlug}/projects/${projectKey}/cycles`;
        const isCyclesActive = pathname === cyclesHref;
        return (
          <Link
            key="cycle"
            href={cyclesHref}
            className={cn(
              "relative px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap",
              isCyclesActive
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {cycleNavLabel}
            {isCyclesActive && (
              <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary rounded-full" />
            )}
          </Link>
        );
      })()}

      {canCreateBoards && (
        <Link
          href={newBoardHref}
          aria-current={pathname === newBoardHref ? "page" : undefined}
          className={cn(
            "relative flex items-center gap-1 px-2 py-2 text-sm font-medium transition-colors whitespace-nowrap ml-1",
            pathname === newBoardHref
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <Plus className="h-3.5 w-3.5" />
          New Board
          {pathname === newBoardHref && (
            <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary rounded-full" />
          )}
        </Link>
      )}

      {/* Members — project-scoped access (project managers + org admins). */}
      <Link
        href={membersHref}
        aria-current={pathname === membersHref ? "page" : undefined}
        className={cn(
          "relative ml-auto flex items-center gap-1 px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap",
          pathname === membersHref
            ? "text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Users className="h-3.5 w-3.5" />
        Members
        {pathname === membersHref && (
          <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary rounded-full" />
        )}
      </Link>

      <Dialog
        open={boardToDelete !== null}
        onOpenChange={(o) => {
          if (!o) setBoardToDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete board?</DialogTitle>
            <DialogDescription>
              This deletes the board{" "}
              {boardToDelete ? `"${boardToDelete.name}"` : ""} and its column
              configuration. Work items are kept — they just stop showing on this
              board. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBoardToDelete(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteBoard}
              disabled={deleting}
            >
              {deleting ? "Deleting…" : "Delete board"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
