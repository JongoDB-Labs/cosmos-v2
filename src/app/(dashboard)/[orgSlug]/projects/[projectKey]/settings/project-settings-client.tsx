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

interface ProjectSettingsClientProps {
  orgId: string;
  orgSlug: string;
  projectId: string;
  projectName: string;
  projectKey: string;
  projectDescription: string;
  enabledFeatures: string[];
  disabledBoardTypes: string[];
}

// The optional project features that surface as board tabs (board-tabs.tsx).
// Keep keys in sync with TOGGLEABLE_FEATURES in the project PUT route.
const FEATURE_OPTIONS: { key: string; label: string; description: string }[] = [
  { key: "okr", label: "OKRs", description: "Objectives & key results board." },
  { key: "goal", label: "Goals", description: "Track project goals with rollup progress." },
  { key: "kpi", label: "KPIs", description: "Track metrics with targets and trend charts." },
  { key: "milestone", label: "Milestones", description: "Key dates on a delivery timeline." },
  { key: "interval", label: "Intervals / Sprints", description: "Time-boxed iterations of work." },
  { key: "roadmap", label: "Roadmap", description: "Navigable program roadmap (phases, LOEs, risks, decisions) that issues link to as source-of-truth." },
  { key: "files", label: "Files", description: "Upload & navigate project documents (docx/pdf/pptx/xlsx); convert them to items." },
  { key: "pm-dashboard", label: "PM Dashboard", description: "GovCon program-management suite: risk/change/blocked/schedule/deliverables/vendors/staffing/CLIN registers with drill-down, derived metrics & Excel export." },
  // PM Dashboard register sub-tabs (require PM Dashboard; each adds a sub-tab).
  { key: "risk-register", label: "PM · Risk Register", description: "Risk register sub-tab (likelihood × impact, mitigation, owner)." },
  { key: "change-log", label: "PM · Change Log", description: "Change-request register sub-tab (cost/schedule impact, approvals)." },
  { key: "blocked-items", label: "PM · Blocked Items", description: "Blocker register sub-tab (what unblocks, owner, escalation)." },
  { key: "schedule-variance", label: "PM · Schedule", description: "Schedule/milestone variance sub-tab (baseline vs projected vs actual)." },
  { key: "deliverables-tracker", label: "PM · Deliverables", description: "CDRL/deliverable tracker sub-tab (due dates, gov review, revisions)." },
  { key: "vendors", label: "PM · Vendors", description: "Vendor/subcontract register sub-tab (agreements, value, performance)." },
  { key: "staffing", label: "PM · Staffing", description: "Staffing & compliance sub-tab (allocation, CAC/NDA/training status)." },
  { key: "clin-burn", label: "PM · CLIN Burn", description: "CLIN funding/burn sub-tab (ceiling, funded, period of performance)." },
];

// The 13 board VIEW types. A project starts with all enabled; toggling one OFF
// records it in settings.disabledBoardTypes, which hides it from "New board".
const BOARD_TYPE_OPTIONS: { key: string; label: string; description: string }[] = [
  { key: "KANBAN", label: "Kanban", description: "Drag-drop columns with WIP limits & swimlanes." },
  { key: "SCRUM", label: "Scrum / Sprint", description: "Active-sprint board with the Kanban scoped to it." },
  { key: "BACKLOG", label: "Backlog", description: "Ranked product backlog with sprint assignment." },
  { key: "TABLE", label: "Table", description: "Sortable, filterable spreadsheet-style grid." },
  { key: "CALENDAR", label: "Calendar", description: "Due dates & ceremonies on a month/week view." },
  { key: "TIMELINE", label: "Timeline / Gantt", description: "Interactive schedule with dependencies (or a static Release Timeline)." },
  { key: "ROADMAP", label: "Roadmap", description: "Strategic epic swimlanes across increments." },
  { key: "OKR", label: "OKRs", description: "Objectives & key results." },
  { key: "DASHBOARD", label: "Dashboard", description: "Rollup widgets & metrics." },
  { key: "PORTFOLIO", label: "Portfolio", description: "Cross-project rollup dashboard." },
  { key: "PROGRAM", label: "Program", description: "Program-level rollup dashboard." },
  { key: "RAID", label: "RAID Log", description: "Risks, assumptions, issues & dependencies." },
  { key: "CFD", label: "Cumulative Flow", description: "Cumulative-flow diagram of work over time." },
];

export function ProjectSettingsClient({
  orgId,
  orgSlug,
  projectId,
  projectName,
  projectKey,
  projectDescription,
  enabledFeatures,
  disabledBoardTypes,
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
  const [savingTypes, setSavingTypes] = useState(false);

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
