"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Archive, Trash2, Loader2, AlertTriangle, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  BOARD_TYPE_ORDER,
  BOARD_TYPE_REGISTRY,
  boardTypeLabel,
} from "@/lib/boards/board-types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  usePermissions,
  Permission,
} from "@/components/providers/permissions-provider";
// The optional project features that surface as board tabs (board-tabs.tsx).
// Defined once alongside the TOGGLEABLE_FEATURES the project PUT validates
// against, so this picker cannot offer a key the API silently drops.
import { FEATURE_OPTIONS } from "@/lib/project-features";
import { useWorkItemTypes } from "@/hooks/use-work-item-types";
import { resolveLinkTypeId } from "@/lib/okr/link-type-default";

interface ProjectSettingsClientProps {
  orgId: string;
  orgSlug: string;
  projectId: string;
  projectName: string;
  projectKey: string;
  projectDescription: string;
  enabledFeatures: string[];
  disabledBoardTypes: string[];
  krLinkTypeId: string | null;
  objectiveLinkTypeId: string | null;
  boards: { id: string; name: string; type: string }[];
  hiddenBoardIds: string[];
  teamScopedAccess: boolean;
}

// Every board VIEW type, derived from the one registry so this list cannot
// drift from the Prisma enum. A project starts with all enabled; turning one off
// records it in settings.disabledBoardTypes, which hides it from board creation.
const BOARD_TYPE_OPTIONS: { key: string; label: string; description: string }[] =
  BOARD_TYPE_ORDER.map((key) => ({
    key,
    label: BOARD_TYPE_REGISTRY[key].label,
    description: BOARD_TYPE_REGISTRY[key].description,
  }));

export function ProjectSettingsClient({
  orgId,
  orgSlug,
  projectId,
  projectName,
  projectKey,
  projectDescription,
  enabledFeatures,
  disabledBoardTypes,
  krLinkTypeId,
  objectiveLinkTypeId,
  boards,
  hiddenBoardIds,
  teamScopedAccess,
}: ProjectSettingsClientProps) {
  const router = useRouter();
  const { can } = usePermissions();

  const [name, setName] = useState(projectName);
  const [description, setDescription] = useState(projectDescription);
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [features, setFeatures] = useState<string[]>(enabledFeatures);
  const [savingFeatures, setSavingFeatures] = useState(false);
  const [disabledTypes, setDisabledTypes] = useState<string[]>(disabledBoardTypes);
  const [hiddenBoards, setHiddenBoards] = useState<string[]>(hiddenBoardIds);
  const [savingBoards, setSavingBoards] = useState(false);
  const [teamScoped, setTeamScoped] = useState(teamScopedAccess);
  const [savingScope, setSavingScope] = useState(false);
  const [savingTypes, setSavingTypes] = useState(false);
  const [krType, setKrType] = useState<string | null>(krLinkTypeId);
  const [objType, setObjType] = useState<string | null>(objectiveLinkTypeId);
  const [savingLinkType, setSavingLinkType] = useState(false);
  // The org's types, so the picker offers real ids. `resolveLinkTypeId` tells us
  // what an unset value actually resolves to, which is what the row shows as the
  // default rather than a bare "None".
  const { types } = useWorkItemTypes(orgId);
  const krResolvedName =
    types.find((t) => t.id === resolveLinkTypeId(krType, types))?.name ?? null;
  const objResolvedName =
    types.find((t) => t.id === resolveLinkTypeId(objType, types))?.name ?? null;

  const canUpdate = can(Permission.PROJECT_UPDATE);
  const canDelete = can(Permission.PROJECT_DELETE);
  const dirty = name !== projectName || description !== projectDescription;

  async function handleSaveGeneral() {
    if (!name.trim()) {
      toast.error("Project name is required");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/projects/${projectId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description }),
      });
      if (!res.ok) throw new Error("Failed to update project");
      // Mirror the trimmed value the server stored so `dirty` settles to false
      // (router.refresh() updates props but not this already-mounted state).
      setName(name.trim());
      toast.success("Project updated");
      router.refresh();
    } catch {
      toast.error("Failed to update project");
    } finally {
      setSaving(false);
    }
  }

  /**
   * #52 — which work-item type the KR / objective link pickers offer first.
   *
   * Sent as a `workItemTypeId`, never a constructed type key: "Feature" is a
   * CUSTOM type whose key is BARE in some orgs, and building
   * `${sector}.feature` has broken type resolution here before. "" in the
   * <select> means "not configured" and is sent as null, which makes the reader
   * fall back to the type NAMED "Feature".
   */
  async function saveLinkType(
    field: "krLinkTypeId" | "objectiveLinkTypeId",
    value: string | null,
  ) {
    const setLocal = field === "krLinkTypeId" ? setKrType : setObjType;
    const prev = field === "krLinkTypeId" ? krType : objType;
    setLocal(value); // optimistic
    setSavingLinkType(true);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/projects/${projectId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      if (!res.ok) throw new Error("Failed to update link type");
      toast.success("Link type saved");
    } catch {
      setLocal(prev); // rollback
      toast.error("Failed to update link type");
    } finally {
      setSavingLinkType(false);
    }
  }

  async function toggleFeature(key: string, on: boolean) {
    const next = on
      ? [...new Set([...features, key])]
      : features.filter((f) => f !== key);
    const prev = features;
    setFeatures(next); // optimistic
    setSavingFeatures(true);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/projects/${projectId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabledFeatures: next }),
      });
      if (!res.ok) throw new Error("Failed to update features");
      toast.success(on ? "Module enabled" : "Module disabled");
      router.refresh(); // re-render the project tabs
    } catch {
      setFeatures(prev); // rollback
      toast.error("Failed to update features");
    } finally {
      setSavingFeatures(false);
    }
  }

  // `on` = allowed/enabled. We persist the DISABLED set (opt-out), so an existing
  // project with no setting keeps all 13 board types.
  async function toggleBoardType(key: string, on: boolean) {
    const next = on
      ? disabledTypes.filter((t) => t !== key)
      : [...new Set([...disabledTypes, key])];
    const prev = disabledTypes;
    setDisabledTypes(next); // optimistic
    setSavingTypes(true);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/projects/${projectId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disabledBoardTypes: next }),
      });
      if (!res.ok) throw new Error("Failed to update board types");
      toast.success(on ? "Board type enabled" : "Board type disabled");
      router.refresh();
    } catch {
      setDisabledTypes(prev); // rollback
      toast.error("Failed to update board types");
    } finally {
      setSavingTypes(false);
    }
  }

  /**
   * Show/hide a board for the whole project.
   *
   * Writes settings.hiddenBoardIds, which the project layout has always read as
   * the baseline (`tp.hiddenBoardIds ?? projectSettings.hiddenBoardIds`) — the
   * mechanism existed with no way to set it. It is a BASELINE, not a lock: a
   * member who has already tailored their own strip keeps their choice, and
   * anyone can re-show a board from the strip's overflow menu. The board and its
   * data are untouched, which is why this is not a permission.
   */
  async function toggleBoard(boardId: string, on: boolean) {
    const next = on
      ? hiddenBoards.filter((id) => id !== boardId)
      : [...new Set([...hiddenBoards, boardId])];
    const prev = hiddenBoards;
    setHiddenBoards(next); // optimistic
    setSavingBoards(true);
    try {
      // settings shallow-merges server-side, so this cannot clobber
      // disabledBoardTypes or anything else already stored there.
      const res = await fetch(`/api/v1/orgs/${orgId}/projects/${projectId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { hiddenBoardIds: next } }),
      });
      if (!res.ok) throw new Error("Failed to update default boards");
      toast.success(on ? "Board shown by default" : "Board hidden by default");
      router.refresh();
    } catch {
      setHiddenBoards(prev); // rollback
      toast.error("Failed to update default boards");
    } finally {
      setSavingBoards(false);
    }
  }

  /**
   * Limit the project to its members.
   *
   * OFF for every project until someone turns it on — the historical posture is
   * "any org member with the read bit sees every project", and flipping that
   * wholesale would hide live projects from people who use them daily. On, only
   * project members (plus org admins and the owner) can see it.
   *
   * The API restricts this to canManageProject even though the rest of this page
   * needs only PROJECT_UPDATE: it decides who can SEE the project, so it is not
   * an ordinary settings edit.
   */
  async function toggleTeamScoped(on: boolean) {
    const prev = teamScoped;
    setTeamScoped(on); // optimistic
    setSavingScope(true);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/projects/${projectId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamScopedAccess: on }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Failed to update project visibility");
      }
      toast.success(on ? "Project limited to its members" : "Project visible to the whole org");
      router.refresh();
    } catch (err) {
      setTeamScoped(prev); // rollback
      toast.error(err instanceof Error ? err.message : "Failed to update project visibility");
    } finally {
      setSavingScope(false);
    }
  }

  async function handleArchive() {
    setArchiving(true);
    try {
      const res = await fetch(
        `/api/v1/orgs/${orgId}/projects/${projectId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived: true }),
        }
      );
      if (!res.ok) throw new Error("Failed to archive project");
      toast.success("Project archived");
      router.push(`/${orgSlug}/projects`);
    } catch {
      toast.error("Failed to archive project");
      setArchiving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/v1/orgs/${orgId}/projects/${projectId}`,
        { method: "DELETE" }
      );
      if (!res.ok) throw new Error("Failed to delete project");
      toast.success("Project deleted");
      router.push(`/${orgSlug}/projects`);
    } catch {
      toast.error("Failed to delete project");
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-10">
      {/* General settings */}
      <div className="rounded-lg border">
        <div className="border-b px-4 py-3">
          <h3 className="text-sm font-semibold">General</h3>
        </div>
        <div className="space-y-4 p-4">
          <div className="space-y-1.5">
            <Label htmlFor="project-name">Project name</Label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canUpdate}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="project-key">Project key</Label>
            <Input
              id="project-key"
              value={projectKey}
              disabled
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              The key is fixed once a project is created.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="project-description">Description</Label>
            <Textarea
              id="project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this project about?"
              className="min-h-20"
              disabled={!canUpdate}
            />
          </div>
          <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
            {canUpdate ? (
              dirty ? (
                <Button size="sm" onClick={handleSaveGeneral} disabled={saving}>
                  {saving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  Save changes
                </Button>
              ) : (
                <span className="flex items-center gap-1">
                  <Check className="h-3.5 w-3.5 text-[var(--status-done,green)]" />
                  All changes saved
                </span>
              )
            ) : null}
          </div>
        </div>
      </div>

      {/* Features */}
      <div className="rounded-lg border">
        <div className="flex items-start justify-between border-b px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">Modules</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Optional capabilities that show up as project tabs — OKRs, Goals,
              KPIs, the PM suites, Files. (Not board views — see Board Types below.)
            </p>
          </div>
          {savingFeatures ? (
            <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : null}
        </div>
        <div className="divide-y">
          {FEATURE_OPTIONS.map((f) => {
            const on = features.includes(f.key);
            return (
              <div
                key={f.key}
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <div>
                  <p className="text-sm font-medium">{f.label}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {f.description}
                  </p>
                </div>
                <ToggleSwitch
                  checked={on}
                  onCheckedChange={(v) => toggleFeature(f.key, v)}
                  disabled={!canUpdate || savingFeatures}
                  aria-label={`${on ? "Disable" : "Enable"} ${f.label}`}
                />
              </div>
            );
          })}
        </div>
        <div className="border-t px-4 py-2.5">
          <p className="text-xs text-muted-foreground">
            Enabled modules appear as tabs on this project. Disabling one hides
            its tab; existing data is kept.
          </p>
        </div>
      </div>

      {/* Link types — #52 */}
      <div className="rounded-lg border">
        <div className="flex items-start justify-between border-b px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">Delivery mapping</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Which kind of work a key result or an objective is tracked against,
              so stakeholders can read progress off real delivery. Defaults to
              Feature. Other types stay linkable either way — this only sets what
              the picker offers first.
            </p>
          </div>
          {savingLinkType ? (
            <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : null}
        </div>
        <div className="divide-y">
          <LinkTypeRow
            label="Key results deliver"
            hint="A key result's linked tickets — its progress tracks how many are done."
            value={krType}
            resolvedName={krResolvedName}
            types={types}
            disabled={!canUpdate || savingLinkType}
            onChange={(v) => saveLinkType("krLinkTypeId", v)}
          />
          <LinkTypeRow
            label="Objectives deliver"
            hint="Objectives ladder to other objectives by default. Choose a type here to link them to work items instead."
            value={objType}
            resolvedName={objResolvedName}
            types={types}
            disabled={!canUpdate || savingLinkType}
            onChange={(v) => saveLinkType("objectiveLinkTypeId", v)}
          />
        </div>
      </div>

      {/* Visibility — who can see this project at all. */}
      <div className="rounded-lg border">
        <div className="flex items-start justify-between border-b px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">Visibility</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Who in the organisation can see this project.
            </p>
          </div>
          {savingScope ? (
            <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : null}
        </div>
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">Limit to project members</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Off, anyone in the organisation with read access sees this project.
              On, only its members do — plus org admins and the owner, who always
              retain access so a project cannot be locked away from its
              administrators. Use this for work a subcontractor or partner team
              should not see.
            </p>
          </div>
          <ToggleSwitch
            checked={teamScoped}
            disabled={!canUpdate || savingScope}
            onCheckedChange={toggleTeamScoped}
            aria-label="Limit this project to its members"
          />
        </div>
      </div>

      {/* Default boards — which of this project's boards everyone sees. */}
      <div className="rounded-lg border">
        <div className="flex items-start justify-between border-b px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">Default Boards</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Which of this project&apos;s boards appear in the strip for everyone
              by default. Turning one off hides the tab — the board and its items
              are untouched, and anyone can bring it back from the strip&apos;s
              overflow menu.
            </p>
          </div>
          {savingBoards ? (
            <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : null}
        </div>
        {boards.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            This project has no boards yet.
          </p>
        ) : (
          <div className="divide-y">
            {boards.map((b) => {
              const on = !hiddenBoards.includes(b.id);
              return (
                <div
                  key={b.id}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{b.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {boardTypeLabel(b.type)}
                    </div>
                  </div>
                  <ToggleSwitch
                    checked={on}
                    disabled={!canUpdate || savingBoards}
                    onCheckedChange={(v) => toggleBoard(b.id, v)}
                    aria-label={`Show ${b.name} by default`}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Board Types */}
      <div className="rounded-lg border">
        <div className="flex items-start justify-between border-b px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold">Board Types</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Which board <em>views</em> this project can create from “New board”
              (Kanban, Table, Timeline, RAID, …). Disabling one just hides it from
              the gallery.
            </p>
          </div>
          {savingTypes ? (
            <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : null}
        </div>
        <div className="divide-y">
          {BOARD_TYPE_OPTIONS.map((b) => {
            const on = !disabledTypes.includes(b.key);
            return (
              <div
                key={b.key}
                className="flex items-center justify-between gap-4 px-4 py-3"
              >
                <div>
                  <p className="text-sm font-medium">{b.label}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {b.description}
                  </p>
                </div>
                <ToggleSwitch
                  checked={on}
                  onCheckedChange={(v) => toggleBoardType(b.key, v)}
                  disabled={!canUpdate || savingTypes}
                  aria-label={`${on ? "Disable" : "Enable"} ${b.label} boards`}
                />
              </div>
            );
          })}
        </div>
        <div className="border-t px-4 py-2.5">
          <p className="text-xs text-muted-foreground">
            Which board views this project can create. Disabling one hides it from
            “New board”; existing boards of that type are kept and still open.
          </p>
        </div>
      </div>

      {/* Danger zone */}
      <div className="rounded-lg border border-destructive/30">
        <div className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/5 px-4 py-3 rounded-t-lg">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          <h3 className="text-sm font-semibold text-destructive">
            Danger zone
          </h3>
        </div>

        <div className="divide-y divide-destructive/20">
          {/* Archive */}
          <div className="flex items-center justify-between gap-4 px-4 py-4">
            <div>
              <p className="text-sm font-medium">Archive this project</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Hide the project from navigation. It can be restored later.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={!canUpdate || archiving}
              onClick={handleArchive}
              className="gap-1.5 shrink-0"
            >
              {archiving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Archive className="h-3.5 w-3.5" />
              )}
              Archive project
            </Button>
          </div>

          {/* Delete */}
          <div className="flex items-center justify-between gap-4 px-4 py-4">
            <div>
              <p className="text-sm font-medium">Delete this project</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Permanently delete this project and all its data. This action
                cannot be undone.
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              disabled={!canDelete}
              onClick={() => setDeleteOpen(true)}
              className="gap-1.5 shrink-0"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete project
            </Button>
          </div>
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete project?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              This will permanently delete{" "}
              <strong>{projectName}</strong> and all of its boards,
              work items, and intervals. This action cannot be undone.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="delete-confirm">
                Type <strong>{projectName}</strong> to confirm
              </Label>
              <Input
                id="delete-confirm"
                value={deleteConfirm}
                onChange={(e) => setDeleteConfirm(e.target.value)}
                placeholder={projectName}
                autoComplete="off"
              />
            </div>
          </div>
          <DialogFooter showCloseButton>
            <Button
              variant="destructive"
              disabled={deleteConfirm !== projectName || deleting}
              onClick={handleDelete}
            >
              {deleting && <Loader2 className="animate-spin" />}
              Delete project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** One "what does this deliver" picker. */
function LinkTypeRow({
  label,
  hint,
  value,
  resolvedName,
  types,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  value: string | null;
  resolvedName: string | null;
  types: { id: string; name: string }[];
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      </div>
      <select
        aria-label={label}
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        className="h-8 shrink-0 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 text-xs disabled:opacity-50"
      >
        <option value="">
          {resolvedName ? `Default (${resolvedName})` : "No preference"}
        </option>
        {types.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </div>
  );
}
