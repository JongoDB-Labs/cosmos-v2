"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Plus, Users, Trash2, Star, Pencil, ChevronLeft, ChevronRight, EyeOff, Eye } from "lucide-react";
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
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
  slug: string | null;
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
  /** Whether the actor may set the PROJECT-WIDE default view — the tab everyone
   *  without a personal override lands on (org PROJECT_UPDATE or project
   *  MANAGER). Unlocks the "Set as default for everyone" tab action. */
  canSetProjectDefault?: boolean;
  /** The project's current default board (baseline) — from
   *  Project.settings.defaultBoardId. Kept for back-compat; the effective
   *  `defaultTab` (a board:/feature: token, now per-user) supersedes it. */
  defaultBoardId?: string | null;
  /** The default landing tab as a token (`board:<id>` | `feature:<key>`) —
   *  EFFECTIVE value composed in layout.tsx as user pref ?? project ?? null.
   *  Drives the ⭐ + the project page redirect. */
  defaultTab?: string | null;
  /** The PROJECT-WIDE default token (`board:<id>` | `feature:<key>`) on its own
   *  — the manager baseline BEFORE the per-user override blends in. Used to hide
   *  "Set as default for everyone" on the tab that's already the team default. */
  projectDefaultTab?: string | null;
  /** Board ids hidden from THIS user's strip — effective value (user tabPrefs ??
   *  project baseline). Anyone can hide/show from a tab's menu; the board row
   *  itself is untouched. */
  hiddenBoardIds?: string[];
  /** Feature-tab keys hidden from THIS user's strip (e.g. "pm-dashboard",
   *  "goal", "cycle") — effective (user ?? project). The feature stays enabled;
   *  only the tab is hidden for this user. */
  hiddenFeatureTabs?: string[];
  /** Unified strip order as tokens (`board:<id>` | `feature:<key>`) — EFFECTIVE
   *  (user ?? project). Authoritative for the strip; tokens not present sort
   *  last (boards by sortOrder, then feature tabs in build order). May include
   *  tokens for hidden tabs (they keep their slot, just aren't shown). */
  tabOrder?: string[];
  /** Per-feature custom labels (`{ goal: "Objectives" }`) — EFFECTIVE (user ??
   *  project). Rendered label is featureTabLabels[key] ?? <defaultLabel>. */
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
  canSetProjectDefault = false,
  defaultBoardId = null,
  defaultTab = null,
  projectDefaultTab = null,
  hiddenBoardIds = [],
  hiddenFeatureTabs = [],
  tabOrder = [],
  featureTabLabels = {},
}: ProjectBoardTabsProps) {
  const pathname = usePathname();
  const router = useRouter();

  const hiddenSet = new Set(hiddenBoardIds);
  const hiddenFeatureSet = new Set(hiddenFeatureTabs);
  const [hiding, setHiding] = useState(false);
  // Optimistic order override applied on drag end so the strip re-flows
  // immediately; cleared once the server round-trip + router.refresh() land the
  // authoritative order back through props.
  const [optimisticOrder, setOptimisticOrder] = useState<string[] | null>(null);

  // Persist a per-user tab-prefs patch (order / hidden / default / labels).
  // Merged server-side into the caller's UserPreferences.tabPrefs[projectId] —
  // this is the user's OWN view, NOT a shared project setting.
  async function patchTabPrefs(patch: Record<string, unknown>) {
    setHiding(true);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/projects/${projectId}/tab-prefs`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`Failed (HTTP ${res.status})`);
      router.refresh();
    } catch (err) {
      notifyError(err, "Couldn't update your tabs.");
    } finally {
      setHiding(false);
    }
  }

  const handleUnhideFeature = (feature: string) =>
    patchTabPrefs({ hiddenFeatureTabs: hiddenFeatureTabs.filter((f) => f !== feature) });

  const handleUnhide = (id: string) =>
    patchTabPrefs({ hiddenBoardIds: hiddenBoardIds.filter((x) => x !== id) });

  const [boardToDelete, setBoardToDelete] = useState<BoardTab | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [settingDefault, setSettingDefault] = useState(false);
  const [settingProjectDefault, setSettingProjectDefault] = useState(false);
  // Rename works for BOTH kinds: a board (PUT name — SHARED) or a feature tab
  // (patchTabPrefs featureTabLabels — PER USER). `tabToRename` holds whichever
  // the actor opened the dialog on.
  const [tabToRename, setTabToRename] = useState<Tab | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [moving, setMoving] = useState(false);

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

  if (enabledFeatures.includes("dependencies")) {
    featureTabs.push({
      feature: "dependencies",
      label: "Dependencies",
      href: `/${orgSlug}/projects/${projectKey}/dependencies`,
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

  // ── Unified Tab model ───────────────────────────────────────────────────
  // Every board (visible + hidden) and every ENABLED feature tab become a Tab
  // with a stable `token`. featureTabLabels override the rendered label.
  const boardTabs: Tab[] = boards.map((board) => ({
    token: `board:${board.id}`,
    kind: "board" as const,
    label: board.name,
    // Human-readable slug when present; fall back to id for legacy boards.
    href: `/${orgSlug}/projects/${projectKey}/boards/${board.slug ?? board.id}`,
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
  // boards-by-sortOrder then features-by-build-order. `optimisticOrder` (set on
  // drag end) wins over the prop order until the refresh lands.
  const effectiveOrder = optimisticOrder ?? tabOrder;
  const orderIndex = new Map(effectiveOrder.map((token, i) => [token, i]));
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

  // The PROJECT-WIDE default token (manager baseline) on its own — the raw
  // project setting, NOT the per-user blend. `projectDefaultTab` (a board:/feature:
  // token) wins, else the legacy project-level `defaultBoardId`. Used to hide the
  // "Set as default for everyone" action on the tab that's already the team default.
  const projectDefaultToken =
    projectDefaultTab ?? (defaultBoardId ? `board:${defaultBoardId}` : null);

  // Drag reorder is available to EVERY authenticated member (it tailors their
  // OWN strip). A press-and-drag past the activation distance reorders; a plain
  // click (no movement) falls through to the tab's <Link> and navigates.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  // dnd attaches client-only attributes; render plain tabs on the server + first
  // client render (so hydration matches), then enable drag after mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot post-hydration mount flag
    setMounted(true);
  }, []);

  // ── Handlers ────────────────────────────────────────────────────────────

  async function handleHide(tab: Tab) {
    if (tab.kind === "board") {
      const board = tab.board!;
      await patchTabPrefs({
        hiddenBoardIds: [...hiddenBoardIds.filter((id) => id !== board.id), board.id],
      });
      // If we're viewing the board we just hid, move to another visible board.
      if (pathname === tab.href) {
        const next = visibleTabs.find((t) => t.token !== tab.token);
        router.push(next ? next.href : `/${orgSlug}/projects/${projectKey}`);
      }
    } else {
      const feature = tab.feature!.feature;
      await patchTabPrefs({
        hiddenFeatureTabs: [...hiddenFeatureTabs.filter((f) => f !== feature), feature],
      });
      // If viewing the tab we just hid, fall back to the project root.
      if (pathname === tab.href || pathname.startsWith(`${tab.href}/`)) {
        router.push(`/${orgSlug}/projects/${projectKey}`);
      }
    }
  }

  // Persist a full token order to the caller's per-user tab prefs. Shared by
  // the drag handler and the Move-left/right menu items (a11y / no-pointer
  // fallback). Optimistically applies `order` so the strip re-flows at once.
  async function persistOrder(fullOrder: string[]) {
    setMoving(true);
    setOptimisticOrder(fullOrder);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/projects/${projectId}/tab-prefs`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tabOrder: fullOrder }),
      });
      if (!res.ok) throw new Error(`Failed to reorder (HTTP ${res.status})`);
      router.refresh();
    } catch (err) {
      setOptimisticOrder(null); // roll back the optimistic reorder
      notifyError(err, "Couldn't reorder the tabs.");
    } finally {
      setMoving(false);
    }
  }

  // Move a tab left/right in the UNIFIED strip. Operates on the rendered
  // (visible, ordered) list: swap the clicked tab with its visible neighbor,
  // then write the FULL token order (hidden tokens kept in their existing
  // relative positions) to the caller's tab prefs in ONE PUT. Boards AND
  // feature tabs move identically; board.sortOrder is now only the fallback.
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

    await persistOrder(fullOrder);
  }

  // Drag-to-reorder end: compute the NEW visible-token order (move the dragged
  // token to the drop target's visible slot), then splice it back into the FULL
  // token order so hidden tokens keep their relative slots (same approach as
  // handleMove). Persist as the user's tabOrder.
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeToken = active.id as string;
    const overToken = over.id as string;

    const visibleTokens = visibleTabs.map((t) => t.token);
    const from = visibleTokens.indexOf(activeToken);
    const to = visibleTokens.indexOf(overToken);
    if (from === -1 || to === -1) return;

    // New VISIBLE order after moving `active` to `over`'s slot.
    const newVisible = [...visibleTokens];
    newVisible.splice(from, 1);
    newVisible.splice(to, 0, activeToken);

    // Rebuild the FULL order: walk the current full order and, at each visible
    // slot, emit the next token from `newVisible`; hidden tokens keep their
    // exact positions. This preserves hidden tokens' interleaving (identical to
    // handleMove's "keep hidden slots" guarantee).
    const visibleSet = new Set(visibleTokens);
    const fullOrder = allTabs.map((t) => t.token);
    let vi = 0;
    const nextFull = fullOrder.map((token) =>
      visibleSet.has(token) ? newVisible[vi++] : token,
    );

    void persistOrder(nextFull);
  }

  // FR "Default view": pick the tab YOU land on. Persisted PER USER as a token
  // in tabPrefs[projectId].defaultTab and honored by the project page redirect —
  // works for boards AND feature tabs.
  async function handleSetDefault(tab: Tab) {
    setSettingDefault(true);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/projects/${projectId}/tab-prefs`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultTab: tab.token }),
      });
      if (!res.ok) throw new Error(`Failed (HTTP ${res.status})`);
      toast.success(`"${tab.label}" is now your default tab.`);
      router.refresh();
    } catch (err) {
      notifyError(err, "Couldn't set your default tab.");
    } finally {
      setSettingDefault(false);
    }
  }

  // FR "Default view" (manager side): set the PROJECT-WIDE default — the tab
  // every member WITHOUT a personal override lands on when they open the project.
  // Persisted as a token in Project.settings.defaultTab via the manager-gated
  // project PUT (settings merge), and honored by the project page redirect (step
  // 3, after per-user prefs). Manager-only — the button is hidden otherwise and
  // the PUT would 403 anyway.
  async function handleSetProjectDefault(tab: Tab) {
    setSettingProjectDefault(true);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/projects/${projectId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { defaultTab: tab.token } }),
      });
      if (!res.ok) throw new Error(`Failed (HTTP ${res.status})`);
      toast.success(`"${tab.label}" is now the default tab for everyone.`);
      router.refresh();
    } catch (err) {
      notifyError(err, "Couldn't set the default tab for everyone.");
    } finally {
      setSettingProjectDefault(false);
    }
  }

  // Rename a tab. Board → PUT board.name (SHARED — it's the board row, managers
  // only). Feature → write per-user featureTabLabels[key]. Opens via the tab ⋯
  // menu → shared dialog.
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
        const res = await fetch(`/api/v1/orgs/${orgId}/projects/${projectId}/tab-prefs`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            featureTabLabels: { ...featureTabLabels, [tab.feature!.feature]: name },
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
      // project root); otherwise just refresh the tab list. The current URL may be
      // the slug (canonical) or a legacy id link — match either.
      const base = `/${orgSlug}/projects/${projectKey}/boards`;
      if (pathname === `${base}/${board.slug ?? board.id}` || pathname === `${base}/${board.id}`) {
        const next = boards.find((b) => b.id !== board.id);
        router.push(
          next
            ? `${base}/${next.slug ?? next.id}`
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

  // Build the ⋯ action groups for a tab. Order / Set-default / Hide are
  // available to EVERY member (their own view); Rename-board / Delete-board are
  // manager-only (shared board row). Feature-tab rename is per-user, so it's
  // open to everyone.
  function buildTabGroups(tab: Tab, idx: number): ActionMenuGroup[] {
    const isDefault = tab.token === effectiveDefaultToken;
    const isBoard = tab.kind === "board";

    // Group 1: rename + set-default. A board rename is manager-gated; a feature
    // rename (per-user label) is open to everyone.
    const renameItems = [];
    if (isBoard) {
      if (canManageBoards) {
        renameItems.push({
          label: "Rename board",
          icon: Pencil,
          onClick: () => {
            setRenameValue(tab.label);
            setTabToRename(tab);
          },
        });
      }
    } else {
      renameItems.push({
        label: "Rename tab",
        icon: Pencil,
        onClick: () => {
          setRenameValue(tab.label);
          setTabToRename(tab);
        },
      });
    }
    if (!isDefault) {
      renameItems.push({
        // Qualify the label as personal only when the team-default action is
        // also visible (managers), so the two aren't ambiguous.
        label: canSetProjectDefault ? "Set as my default" : "Set as default",
        icon: Star,
        disabled: settingDefault,
        onClick: () => handleSetDefault(tab),
      });
    }
    // Managers/owners/admins can additionally set the PROJECT-WIDE default —
    // hidden on the tab that's already the team default.
    if (canSetProjectDefault && tab.token !== projectDefaultToken) {
      renameItems.push({
        label: "Set as default for everyone",
        icon: Users,
        disabled: settingProjectDefault,
        onClick: () => handleSetProjectDefault(tab),
      });
    }

    // Group 3: hide (everyone) + delete (managers, boards only).
    const hideItems: ActionMenuGroup["items"] = [
      {
        label: "Hide tab",
        icon: EyeOff,
        disabled: hiding,
        onClick: () => handleHide(tab),
      },
    ];
    if (isBoard && canManageBoards) {
      hideItems.push({
        label: "Delete board",
        icon: Trash2,
        variant: "destructive" as const,
        onClick: () => setBoardToDelete(tab.board!),
      });
    }

    const groups: ActionMenuGroup[] = [];
    if (renameItems.length > 0) groups.push({ items: renameItems });
    groups.push({
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
    });
    groups.push({ items: hideItems });
    return groups;
  }

  return (
    <div className="flex items-center gap-1 px-4 border-b overflow-x-auto scrollbar-x">
      {/* Unified strip — boards + enabled feature views, one order. Drag any tab
          to reorder YOUR OWN strip; a plain click still navigates. The ⋯ menu
          per tab gives everyone Move · Set-as-default · Hide (+ per-user feature
          rename); board Rename/Delete stay manager-only. */}
      {(() => {
        const tabProps = (tab: Tab, idx: number) => ({
          tab,
          isActive: tab.prefix
            ? pathname === tab.href || pathname.startsWith(`${tab.href}/`)
            : pathname === tab.href,
          isDefault: tab.token === effectiveDefaultToken,
          groups: buildTabGroups(tab, idx),
        });
        // SSR + first client render: plain tabs (hydration-stable). After mount:
        // the draggable strip.
        if (!mounted) {
          return visibleTabs.map((tab, idx) => (
            <PlainTab key={tab.token} {...tabProps(tab, idx)} />
          ));
        }
        return (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={visibleTabs.map((t) => t.token)}
              strategy={horizontalListSortingStrategy}
            >
              {visibleTabs.map((tab, idx) => (
                <SortableTab key={tab.token} {...tabProps(tab, idx)} />
              ))}
            </SortableContext>
          </DndContext>
        );
      })()}

      {/* Hidden tabs (boards + feature views) — anyone can restore their own. */}
      {hiddenTabs.length > 0 && (
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
                : "Give this tab a new label (just for you)."}
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

// A single strip tab, sortable (drag-to-reorder) with an ⋯ actions menu. The
// whole tab is the drag handle: with the DndContext's distance activation
// constraint a plain click falls through to the <Link> (navigates) while a
// press-and-drag reorders. Every member gets the menu + drag (their own view);
// which ITEMS appear inside is decided by the parent (buildTabGroups).
interface TabItemProps {
  tab: Tab;
  isActive: boolean;
  isDefault: boolean;
  groups: ActionMenuGroup[];
}

/** dnd wiring applied to the LINK only — so the ⋯ trigger (a sibling ActionMenu
 *  renders) stays outside the drag listeners and its click still opens the menu. */
type TabDnd = {
  setNodeRef: (el: HTMLElement | null) => void;
  style: React.CSSProperties;
  listeners: ReturnType<typeof useSortable>["listeners"];
  isDragging: boolean;
};

// One tab: the LINK carries the drag handle (whole-tab drag; distance-6 so a
// click still navigates); ActionMenu adds the ⋯ trigger as a SIBLING of the
// link (NOT under the drag listeners, so its click works). The plain variant
// (SSR / pre-mount) passes no `dnd`, keeping SSR/first-client HTML stable.
function TabItem({ tab, isActive, isDefault, groups, dnd }: TabItemProps & { dnd?: TabDnd }) {
  const link = (
    <Link
      ref={dnd?.setNodeRef as React.Ref<HTMLAnchorElement>}
      href={tab.href}
      draggable={false}
      // dnd `listeners` (pointer drag) only — NOT `attributes`, which would put
      // role="button" on a nav link. Keyboard reorder is via the ⋯ Move items.
      style={dnd?.style}
      {...(dnd?.listeners ?? {})}
      className={cn(
        "relative flex items-center gap-1 px-3 py-2 text-sm font-medium transition-colors whitespace-nowrap select-none",
        dnd && "touch-none cursor-grab active:cursor-grabbing",
        dnd?.isDragging && "opacity-70",
        isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {isDefault && (
        <Star className="h-3 w-3 shrink-0 fill-primary text-primary" aria-label="Default tab" />
      )}
      {tab.label}
      {isActive && (
        <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary rounded-full" />
      )}
    </Link>
  );
  return (
    <div className={cn("group/action relative flex items-center", dnd?.isDragging && "z-20")}>
      {groups.length > 0 ? (
        // Unlike the app-wide hover-reveal ⋯ (dense table rows / kanban cards),
        // project tabs are a low-count primary-nav surface: keep the kebab
        // persistently visible (opacity-70, →100 on hover/focus/open) so the
        // edit/delete/move affordance is DISCOVERABLE without hovering — the
        // reporter's actual complaint (COSMOS-57). Right-click still opens the
        // same menu. No layout shift: the trigger already reserves its slot.
        <ActionMenu
          groups={groups}
          triggerLabel={`Tab actions for ${tab.label}`}
          triggerClassName="opacity-70"
        >
          {link}
        </ActionMenu>
      ) : (
        link
      )}
    </div>
  );
}

// Plain (non-draggable) tab — SSR + first client render (hydration-stable).
function PlainTab(props: TabItemProps) {
  return <TabItem {...props} />;
}

// Draggable tab (post-mount). dnd wiring goes on the link, not the wrapper.
function SortableTab(props: TabItemProps) {
  const { listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: props.tab.token });
  return (
    <TabItem
      {...props}
      dnd={{
        setNodeRef,
        style: { transform: CSS.Transform.toString(transform), transition },
        listeners,
        isDragging,
      }}
    />
  );
}
