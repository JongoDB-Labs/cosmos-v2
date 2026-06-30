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
   *  Project.settings.defaultBoardId. Kept for back-compat; `defaultTab`
   *  (a board:/feature: token) supersedes it when set. */
  defaultBoardId?: string | null;
  /** The default landing tab as a token (`board:<id>` | `feature:<key>`) — from
   *  Project.settings.defaultTab. Generalizes defaultBoardId across feature tabs
   *  too; the project page redirect honors it. */
  defaultTab?: string | null;
  /** Board ids hidden from the tab strip — from Project.settings.hiddenBoardIds.
   *  Managers can hide/show from a board's menu; the board itself is kept. */
  hiddenBoardIds?: string[];
  /** Feature-tab keys hidden from the strip (e.g. "pm-dashboard", "goal",
   *  "cycle") — from Project.settings.hiddenFeatureTabs. The feature stays
   *  enabled; only the tab is hidden. */
  hiddenFeatureTabs?: string[];
  /** Unified strip order as tokens (`board:<id>` | `feature:<key>`) — from
   *  Project.settings.tabOrder. Authoritative for the strip; tokens not present
   *  sort last (boards by sortOrder, then feature tabs in build order). May
   *  include tokens for hidden tabs (they keep their slot, just aren't shown). */
  tabOrder?: string[];
  /** Per-feature custom labels (`{ goal: "Objectives" }`) — from
   *  Project.settings.featureTabLabels. Rendered label is
   *  featureTabLabels[key] ?? <defaultLabel>. */
  featureTabLabels?: Record<string, string>;
  templateDefaultConfig?: Record<string, unknown> | null;
}

interface FeatureTab {
  feature: string;
  label: string;
  href: string;
  /** Match the tab as active on any sub-path (e.g. roadmap node deep-links). */
  prefix?: boolean;
}

// A unified strip tab — a board OR an enabled feature view. `token` is the
// stable identity used for ordering / default / hide across both kinds.
interface Tab {
  token: string;
  kind: "board" | "feature";
  label: string;
  href: string;
  board?: BoardTab;
  feature?: FeatureTab;
  /** Match active on any sub-path (feature tabs only). */
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
  defaultTab = null,
  hiddenBoardIds = [],
  hiddenFeatureTabs = [],
  tabOrder = [],
  featureTabLabels = {},
  templateDefaultConfig,
}: ProjectBoardTabsProps) {
  const pathname = usePathname();
  const router = useRouter();

  const hiddenSet = new Set(hiddenBoardIds);
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

  const handleUnhideFeature = (feature: string) =>
    patchSettings({ hiddenFeatureTabs: hiddenFeatureTabs.filter((f) => f !== feature) });

  const handleUnhide = (id: string) =>
    patchSettings({ hiddenBoardIds: hiddenBoardIds.filter((x) => x !== id) });

  const [boardToDelete, setBoardToDelete] = useState<BoardTab | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [settingDefault, setSettingDefault] = useState(false);
  // Rename works for BOTH kinds: a board (PUT name) or a feature tab
  // (patchSettings featureTabLabels). `tabToRename` holds whichever the manager
  // opened the dialog on.
  const [tabToRename, setTabToRename] = useState<Tab | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [moving, setMoving] = useState(false);

  // Derive cycle nav label from template config, fallback to "Sprints"
  const cycleNavLabel =
    typeof templateDefaultConfig?.cycleNavLabel === "string"
      ? templateDefaultConfig.cycleNavLabel
      : "Sprints";

  const newBoardHref = `/${orgSlug}/projects/${projectKey}/boards/new`;
  const membersHref = `/${orgSlug}/projects/${projectKey}/members`;

  // Build feature tabs based on enabledFeatures. Default labels live here;
  // featureTabLabels[key] overrides the visible label below when building the
  // unified Tab list.
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

  // ── Unified Tab model ───────────────────────────────────────────────────
  // Every board (visible + hidden) and every ENABLED feature tab become a Tab
  // with a stable `token`. featureTabLabels override the rendered label.
  const boardTabs: Tab[] = boards.map((board) => ({
    token: `board:${board.id}`,
    kind: "board" as const,
    label: board.name,
    href: `/${orgSlug}/projects/${projectKey}/boards/${board.id}`,
    board,
  }));

  const featureTabModels: Tab[] = featureTabs.map((feature) => ({
    token: `feature:${feature.feature}`,
    kind: "feature" as const,
    label: featureTabLabels[feature.feature] ?? feature.label,
    href: feature.href,
    feature,
    prefix: feature.prefix,
  }));

  // Build order is the append-fallback: boards first (already sorted by
  // sortOrder upstream), then feature tabs in their build order above.
  const buildOrder: Tab[] = [...boardTabs, ...featureTabModels];

  // Sort by tabOrder token index; tokens NOT in tabOrder sort last in build
  // order. Stable for equal indices (buildIdx tiebreak), so unlisted tabs keep
  // boards-by-sortOrder then features-by-build-order.
  const orderIndex = new Map(tabOrder.map((token, i) => [token, i]));
  const allTabs: Tab[] = buildOrder
    .map((tab, buildIdx) => ({ tab, buildIdx }))
    .sort((a, b) => {
      const ai = orderIndex.has(a.tab.token) ? orderIndex.get(a.tab.token)! : Infinity;
      const bi = orderIndex.has(b.tab.token) ? orderIndex.get(b.tab.token)! : Infinity;
      if (ai !== bi) return ai - bi;
      return a.buildIdx - b.buildIdx;
    })
    .map((entry) => entry.tab);

  const isHidden = (tab: Tab) =>
    tab.kind === "board"
      ? hiddenSet.has(tab.board!.id)
      : hiddenFeatureSet.has(tab.feature!.feature);

  // Rendered strip (ordered, visible) + the restore menu's hidden list.
  const visibleTabs = allTabs.filter((tab) => !isHidden(tab));
  const hiddenTabs = allTabs.filter((tab) => isHidden(tab));

  // The default star follows `defaultTab` when set, falling back to the legacy
  // `defaultBoardId` (as a board: token) for projects that predate defaultTab.
  const effectiveDefaultToken =
    defaultTab ?? (defaultBoardId ? `board:${defaultBoardId}` : null);

  // ── Handlers ────────────────────────────────────────────────────────────

  async function handleHide(tab: Tab) {
    if (tab.kind === "board") {
      const board = tab.board!;
      await patchSettings({
        hiddenBoardIds: [...hiddenBoardIds.filter((id) => id !== board.id), board.id],
      });
      // If we're viewing the board we just hid, move to another visible board.
      if (pathname === tab.href) {
        const next = visibleTabs.find((t) => t.token !== tab.token);
        router.push(next ? next.href : `/${orgSlug}/projects/${projectKey}`);
      }
    } else {
      const feature = tab.feature!.feature;
      await patchSettings({
        hiddenFeatureTabs: [...hiddenFeatureTabs.filter((f) => f !== feature), feature],
      });
      // If viewing the tab we just hid, fall back to the project root.
      if (pathname === tab.href || pathname.startsWith(`${tab.href}/`)) {
        router.push(`/${orgSlug}/projects/${projectKey}`);
      }
    }
  }

  // Move a tab left/right in the UNIFIED strip. Operates on the rendered
  // (visible, ordered) list: swap the clicked tab with its visible neighbor,
  // then write the FULL token order (hidden tokens kept in their existing
  // relative positions) to settings.tabOrder in ONE PUT. Boards AND feature
  // tabs move identically; board.sortOrder is now only the append-fallback.
  async function handleMove(idx: number, dir: "left" | "right") {
    const j = dir === "left" ? idx - 1 : idx + 1;
    if (j < 0 || j >= visibleTabs.length) return;

    const a = visibleTabs[idx].token;
    const b = visibleTabs[j].token;

    // Start from the full ordered token list (authoritative strip order) and
    // swap the two adjacent VISIBLE tokens' positions within it. Hidden tokens
    // interleaved between them keep their slots.
    const fullOrder = allTabs.map((t) => t.token);
    const ai = fullOrder.indexOf(a);
    const bi = fullOrder.indexOf(b);
    if (ai === -1 || bi === -1) return;
    [fullOrder[ai], fullOrder[bi]] = [fullOrder[bi], fullOrder[ai]];

    setMoving(true);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/projects/${projectId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { tabOrder: fullOrder } }),
      });
      if (!res.ok) throw new Error(`Failed to reorder (HTTP ${res.status})`);
      router.refresh();
    } catch (err) {
      notifyError(err, "Couldn't reorder the tabs.");
    } finally {
      setMoving(false);
    }
  }

  // FR "Default view": a manager picks the tab everyone lands on. Persisted as a
  // token in Project.settings.defaultTab (merged server-side) and honored by the
  // project page's redirect — works for boards AND feature tabs.
  async function handleSetDefault(tab: Tab) {
    setSettingDefault(true);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/projects/${projectId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { defaultTab: tab.token } }),
      });
      if (!res.ok) throw new Error(`Failed (HTTP ${res.status})`);
      toast.success(`"${tab.label}" is now the default tab.`);
      router.refresh();
    } catch (err) {
      notifyError(err, "Couldn't set the default tab.");
    } finally {
      setSettingDefault(false);
    }
  }

  // Rename a tab. Board → PUT board.name (server stores it). Feature → write
  // featureTabLabels[key] (settings). Opens via the tab ⋯ menu → shared dialog.
  async function handleRename() {
    const tab = tabToRename;
    if (!tab) return;
    const name = renameValue.trim();
    if (!name || name === tab.label) {
      setTabToRename(null);
      return;
    }
    setRenaming(true);
    try {
      if (tab.kind === "board") {
        const res = await fetch(
          `/api/v1/orgs/${orgId}/projects/${projectId}/boards/${tab.board!.id}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
          },
        );
        if (!res.ok) throw new Error(`Failed to rename (HTTP ${res.status})`);
      } else {
        const res = await fetch(`/api/v1/orgs/${orgId}/projects/${projectId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            settings: {
              featureTabLabels: { ...featureTabLabels, [tab.feature!.feature]: name },
            },
          }),
        });
        if (!res.ok) throw new Error(`Failed to rename (HTTP ${res.status})`);
      }
      toast.success(`Renamed to "${name}".`);
      setTabToRename(null);
      router.refresh();
    } catch (err) {
      notifyError(err, "Couldn't rename the tab.");
    } finally {
      setRenaming(false);
    }
  }

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

  return (
    <div className="flex items-center gap-1 px-4 border-b overflow-x-auto">
      {/* Unified strip — boards + enabled feature views, one order. Every
          visible tab gets the SAME ⋯ menu for managers: Rename · Set as default
          · Move left/right · Hide · (Delete for boards only). */}
      {visibleTabs.map((tab, idx) => {
        const isActive = tab.prefix
          ? pathname === tab.href || pathname.startsWith(`${tab.href}/`)
          : pathname === tab.href;
        const isDefault = tab.token === effectiveDefaultToken;

        const link = (
          <Link
            href={tab.href}
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
                aria-label="Default tab"
              />
            )}
            {tab.label}
            {isActive && (
              <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary rounded-full" />
            )}
          </Link>
        );

        // Non-managers get a plain link (current behavior).
        if (!canManageBoards) return <span key={tab.token}>{link}</span>;

        const groups: ActionMenuGroup[] = [
          {
            items: [
              {
                label: tab.kind === "board" ? "Rename board" : "Rename tab",
                icon: Pencil,
                onClick: () => {
                  setRenameValue(tab.label);
                  setTabToRename(tab);
                },
              },
              ...(isDefault
                ? []
                : [
                    {
                      label: "Set as default",
                      icon: Star,
                      disabled: settingDefault,
                      onClick: () => handleSetDefault(tab),
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
                disabled: moving || idx === visibleTabs.length - 1,
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
                onClick: () => handleHide(tab),
              },
              // Delete is boards-only — feature tabs can't be deleted, only
              // hidden or disabled from Project Settings.
              ...(tab.kind === "board"
                ? [
                    {
                      label: "Delete board",
                      icon: Trash2,
                      variant: "destructive" as const,
                      onClick: () => setBoardToDelete(tab.board!),
                    },
                  ]
                : []),
            ],
          },
        ];

        return (
          <div key={tab.token} className="group/action relative flex items-center">
            <ActionMenu groups={groups} triggerLabel={`Tab actions for ${tab.label}`}>
              {link}
            </ActionMenu>
          </div>
        );
      })}

      {/* Hidden tabs (boards + feature views) — a manager can restore any. */}
      {canManageBoards && hiddenTabs.length > 0 && (
        <ActionMenu
          triggerLabel="Show hidden tabs"
          groups={[
            {
              items: hiddenTabs.map((tab) => ({
                label: `Show "${tab.label}"`,
                icon: Eye,
                disabled: hiding,
                onClick: () =>
                  tab.kind === "board"
                    ? handleUnhide(tab.board!.id)
                    : handleUnhideFeature(tab.feature!.feature),
              })),
            },
          ]}
        >
          <span className="flex items-center gap-1 px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground whitespace-nowrap">
            <EyeOff className="h-3.5 w-3.5" /> Hidden ({hiddenTabs.length})
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
        open={tabToRename !== null}
        onOpenChange={(o) => {
          if (!o) setTabToRename(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {tabToRename?.kind === "board" ? "Rename board" : "Rename tab"}
            </DialogTitle>
            <DialogDescription>
              {tabToRename?.kind === "board"
                ? "Give this board a new name."
                : "Give this tab a new label."}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleRename();
            }}
            placeholder={tabToRename?.kind === "board" ? "Board name" : "Tab label"}
            maxLength={100}
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setTabToRename(null)}
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
