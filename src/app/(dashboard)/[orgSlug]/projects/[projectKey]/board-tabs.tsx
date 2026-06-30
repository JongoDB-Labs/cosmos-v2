"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Plus, Users, Trash2, Star, Pencil, ChevronLeft, ChevronRight, EyeOff, Eye } from "lucide-react";
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
import { Input } from "@/components/ui/input";
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
  /** Board ids hidden from the tab strip — from Project.settings.hiddenBoardIds.
   *  Managers can hide/show from a board's menu; the board itself is kept. */
  hiddenBoardIds?: string[];
  /** Feature-tab keys hidden from the strip (e.g. "pm-dashboard", "goal",
   *  "cycle") — from Project.settings.hiddenFeatureTabs. The feature stays
   *  enabled; only the tab is hidden. */
  hiddenFeatureTabs?: string[];
  templateDefaultConfig?: Record<string, unknown> | null;
}

interface FeatureTab {
  feature: string;
  label: string;
  href: string;
  /** Match the tab as active on any sub-path (e.g. roadmap node deep-links). */
  prefix?: boolean;
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
  hiddenBoardIds = [],
  hiddenFeatureTabs = [],
  templateDefaultConfig,
}: ProjectBoardTabsProps) {
  const pathname = usePathname();
  const router = useRouter();

  // Split boards + feature tabs into visible vs hidden (managers tailor the
  // strip; hiding keeps the board/feature, only the tab goes). Restore from the
  // "Hidden" menu. Reorder/rename/delete operate on visible boards.
  const hiddenSet = new Set(hiddenBoardIds);
  const visibleBoards = boards.filter((b) => !hiddenSet.has(b.id));
  const hiddenBoards = boards.filter((b) => hiddenSet.has(b.id));
  const hiddenFeatureSet = new Set(hiddenFeatureTabs);
  const [hiding, setHiding] = useState(false);

  // Persist a settings patch to Project.settings (merged server-side).
  async function patchSettings(patch: Record<string, unknown>) {
    setHiding(true);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/projects/${projectId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: patch }),
      });
      if (!res.ok) throw new Error(`Failed (HTTP ${res.status})`);
      router.refresh();
    } catch (err) {
      notifyError(err, "Couldn't update hidden tabs.");
    } finally {
      setHiding(false);
    }
  }

  async function handleHide(board: BoardTab) {
    await patchSettings({ hiddenBoardIds: [...hiddenBoardIds.filter((id) => id !== board.id), board.id] });
    // If we're viewing the board we just hid, move to another visible board.
    if (pathname === `/${orgSlug}/projects/${projectKey}/boards/${board.id}`) {
      const next = visibleBoards.find((b) => b.id !== board.id);
      router.push(
        next
          ? `/${orgSlug}/projects/${projectKey}/boards/${next.id}`
          : `/${orgSlug}/projects/${projectKey}`,
      );
    }
  }

  const handleUnhideFeature = (feature: string) =>
    patchSettings({ hiddenFeatureTabs: hiddenFeatureTabs.filter((f) => f !== feature) });

  async function handleHideFeature(tab: FeatureTab) {
    await patchSettings({ hiddenFeatureTabs: [...hiddenFeatureTabs.filter((f) => f !== tab.feature), tab.feature] });
    // If viewing the tab we just hid, fall back to the project root.
    if (pathname === tab.href || pathname.startsWith(`${tab.href}/`)) {
      router.push(`/${orgSlug}/projects/${projectKey}`);
    }
  }

  const handleUnhide = (id: string) =>
    patchSettings({ hiddenBoardIds: hiddenBoardIds.filter((x) => x !== id) });

  const [boardToDelete, setBoardToDelete] = useState<BoardTab | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [settingDefault, setSettingDefault] = useState(false);
  const [boardToRename, setBoardToRename] = useState<BoardTab | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [moving, setMoving] = useState(false);

  // Rename a board (PUT name). Opens via the tab ⋯ menu → dialog.
  async function handleRename() {
    const board = boardToRename;
    if (!board) return;
    const name = renameValue.trim();
    if (!name || name === board.name) {
      setBoardToRename(null);
      return;
    }
    setRenaming(true);
    try {
      const res = await fetch(
        `/api/v1/orgs/${orgId}/projects/${projectId}/boards/${board.id}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        },
      );
      if (!res.ok) throw new Error(`Failed to rename (HTTP ${res.status})`);
      toast.success(`Renamed to "${name}".`);
      setBoardToRename(null);
      router.refresh();
    } catch (err) {
      notifyError(err, "Couldn't rename the board.");
    } finally {
      setRenaming(false);
    }
  }

  // Move a board left/right in the tab strip. Renormalizes EVERY board's
  // sortOrder to its new array index (robust even if existing rows share the
  // default 0), via parallel PUTs, then refreshes.
  async function handleMove(idx: number, dir: "left" | "right") {
    const j = dir === "left" ? idx - 1 : idx + 1;
    if (j < 0 || j >= visibleBoards.length) return;
    const next = [...visibleBoards];
    [next[idx], next[j]] = [next[j], next[idx]];
    setMoving(true);
    try {
      await Promise.all(
        next.map((b, i) =>
          fetch(`/api/v1/orgs/${orgId}/projects/${projectId}/boards/${b.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sortOrder: i }),
          }).then((r) => {
            if (!r.ok) throw new Error(`Failed to reorder (HTTP ${r.status})`);
          }),
        ),
      );
      router.refresh();
    } catch (err) {
      notifyError(err, "Couldn't reorder the boards.");
    } finally {
      setMoving(false);
    }
  }

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

  // PM Dashboard is the single top-level tab for the whole PM suite; the
  // registers (Risk/Change/Blocked/Schedule/Deliverables/Vendors/Staffing/CLIN)
  // now live as sub-tabs INSIDE it (see pm-dashboard/pm-nav.tsx), so they no
  // longer crowd this board strip. `prefix` keeps this tab active on any
  // /pm-dashboard/* sub-page.
  if (enabledFeatures.includes("pm-dashboard")) {
    featureTabs.push({
      feature: "pm-dashboard",
      label: "PM Dashboard",
      href: `/${orgSlug}/projects/${projectKey}/pm-dashboard`,
      prefix: true,
    });
  }

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

  if (enabledFeatures.includes("roadmap")) {
    featureTabs.push({
      feature: "roadmap",
      label: "Roadmap",
      href: `/${orgSlug}/projects/${projectKey}/roadmap`,
      prefix: true, // stay active on /roadmap/<node> deep-links
    });
  }

  if (enabledFeatures.includes("files")) {
    featureTabs.push({
      feature: "files",
      label: "Files",
      href: `/${orgSlug}/projects/${projectKey}/files`,
      prefix: true, // stay active on /files/<doc> deep-links
    });
  }

  // Cycles/Sprints — label is template-driven (e.g. "Sprints"). Folded into the
  // feature-tab list so it gets the same hide/show ⋯ menu as the others.
  if (enabledFeatures.includes("cycle")) {
    featureTabs.push({
      feature: "cycle",
      label: cycleNavLabel,
      href: `/${orgSlug}/projects/${projectKey}/cycles`,
    });
  }

  const visibleFeatureTabs = featureTabs.filter((t) => !hiddenFeatureSet.has(t.feature));
  const hiddenFeatureTabList = featureTabs.filter((t) => hiddenFeatureSet.has(t.feature));

  const membersHref = `/${orgSlug}/projects/${projectKey}/members`;

  return (
    <div className="flex items-center gap-1 px-4 border-b overflow-x-auto">
      {visibleBoards.map((board, idx) => {
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

        // A board manager gets a ⋯ / right-click menu on each tab: rename,
        // set-as-default, move left/right, and delete.
        if (!canManageBoards) return <span key={board.id}>{tab}</span>;
        const groups: ActionMenuGroup[] = [
          {
            items: [
              {
                label: "Rename board",
                icon: Pencil,
                onClick: () => {
                  setRenameValue(board.name);
                  setBoardToRename(board);
                },
              },
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
                label: "Move left",
                icon: ChevronLeft,
                disabled: moving || idx === 0,
                onClick: () => handleMove(idx, "left"),
              },
              {
                label: "Move right",
                icon: ChevronRight,
                disabled: moving || idx === visibleBoards.length - 1,
                onClick: () => handleMove(idx, "right"),
              },
            ],
          },
          {
            items: [
              {
                label: "Hide tab",
                icon: EyeOff,
                disabled: hiding,
                onClick: () => handleHide(board),
              },
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

      {/* Hidden boards — a manager can restore any to the strip. */}
      {/* Feature view tabs (PM Dashboard, Goals, Milestones, Sprints, …) — each
          gets the same Hide ⋯ menu as a board so the whole strip is tailorable. */}
      {visibleFeatureTabs.map((tab) => {
        const isActive = tab.prefix
          ? pathname === tab.href || pathname.startsWith(`${tab.href}/`)
          : pathname === tab.href;

        const link = (
          <Link
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

        if (!canManageBoards) return <span key={tab.feature}>{link}</span>;
        return (
          <div key={tab.feature} className="group/action relative flex items-center">
            <ActionMenu
              triggerLabel={`Tab actions for ${tab.label}`}
              groups={[
                {
                  items: [
                    {
                      label: "Hide tab",
                      icon: EyeOff,
                      disabled: hiding,
                      onClick: () => handleHideFeature(tab),
                    },
                  ],
                },
              ]}
            >
              {link}
            </ActionMenu>
          </div>
        );
      })}

      {/* Hidden tabs (boards + feature views) — a manager can restore any. */}
      {canManageBoards && (hiddenBoards.length > 0 || hiddenFeatureTabList.length > 0) && (
        <ActionMenu
          triggerLabel="Show hidden tabs"
          groups={[
            ...(hiddenBoards.length > 0
              ? [{
                  items: hiddenBoards.map((board) => ({
                    label: `Show "${board.name}"`,
                    icon: Eye,
                    disabled: hiding,
                    onClick: () => handleUnhide(board.id),
                  })),
                }]
              : []),
            ...(hiddenFeatureTabList.length > 0
              ? [{
                  items: hiddenFeatureTabList.map((tab) => ({
                    label: `Show "${tab.label}"`,
                    icon: Eye,
                    disabled: hiding,
                    onClick: () => handleUnhideFeature(tab.feature),
                  })),
                }]
              : []),
          ]}
        >
          <span className="flex items-center gap-1 px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground whitespace-nowrap">
            <EyeOff className="h-3.5 w-3.5" /> Hidden ({hiddenBoards.length + hiddenFeatureTabList.length})
          </span>
        </ActionMenu>
      )}

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

      <Dialog
        open={boardToRename !== null}
        onOpenChange={(o) => {
          if (!o) setBoardToRename(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename board</DialogTitle>
            <DialogDescription>Give this board a new name.</DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleRename();
            }}
            placeholder="Board name"
            maxLength={100}
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBoardToRename(null)}
              disabled={renaming}
            >
              Cancel
            </Button>
            <Button
              onClick={handleRename}
              disabled={renaming || !renameValue.trim()}
            >
              {renaming ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
