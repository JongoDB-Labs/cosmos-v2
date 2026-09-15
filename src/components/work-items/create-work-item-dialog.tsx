"use client";

import { useState, useEffect, useMemo} from "react";
import { Loader2 } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { notifyError } from "@/lib/errors/notify";
import { toast } from "sonner";
import { useCustomFields } from "@/hooks/use-custom-fields";
import { selectableTypes, typesForSector, useWorkItemTypes } from "@/hooks/use-work-item-types";
import {
  CustomFieldInput,
  isCustomFieldEmpty,
  isRenderableCustomField,
} from "@/components/work-items/custom-field-input";
import { createStatusOptions } from "@/lib/boards/status-columns";
import type { Board, BoardColumn, OrgMember, Interval } from "@/types/models";

const PRIORITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;

function titleCase(s: string) {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

/**
 * Pick the default type to preselect: the project's "task" type if present
 * (built-in keys end with `.task`), else the first type. Returns "" when the
 * list is empty (still loading).
 */
function defaultTypeId(types: { id: string; key: string }[]): string {
  if (types.length === 0) return "";
  const task = types.find((t) => t.key === "task" || t.key.endsWith(".task"));
  return (task ?? types[0]).id;
}

const fieldClass =
  "h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none focus:ring-2 focus:ring-ring";

export interface CreateProject {
  id: string;
  key: string;
  name: string;
  /**
   * The project template's sector, scoping the Type picker to the types that
   * belong to this project. Optional and nullable on purpose: a project without
   * a template, or a caller that has not loaded it, gets the full catalogue
   * rather than a silently truncated one.
   */
  sector?: string | null;
}

/** The source issue to seed a duplicate from (COSMOS-13). */
export interface DuplicateSource {
  itemId: string;
  projectId: string;
}

/** The subset of a work item the duplicate draft reads. Matches the GET
 *  /work-items/[itemId] payload (only the core, non-instance-specific fields). */
interface DuplicateSourceItem {
  title: string;
  description: string | null;
  priority: (typeof PRIORITIES)[number];
  workItemTypeId: string | null;
  assigneeId: string | null;
  assignees?: { userId: string }[];
  intervalId: string | null;
  storyPoints: number | null;
  startDate: string | null;
  dueDate: string | null;
  tags?: string[];
  customFields?: Record<string, unknown> | null;
}

/**
 * Full-field "New issue" dialog (Jira-style): every common field is available
 * at creation — title, project, type, priority, assignee, interval, story points,
 * due date, description, labels — not just a title. Resolves the project's first
 * board + column for the required columnKey; the work-items POST already
 * accepts all of these fields. onCreated lets the caller refetch its list.
 */
export function CreateWorkItemDialog({
  orgId,
  open,
  onOpenChange,
  projects,
  prefilledProjectId,
  boardId,
  initialLabels,
  duplicateSource,
  onCreated,
}: {
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: CreateProject[];
  prefilledProjectId?: string;
  /**
   * The board this dialog was opened from, when there is one. Its own columns
   * seed the Status picker; a board with no workflow of its own (Timeline,
   * Calendar, RAID and Roadmap all ship with `columns: []`) falls back to the
   * project's statuses so the picker is never empty.
   */
  boardId?: string;
  /** Labels applied by default. The RAID log seeds its category here so a new
   *  entry never lands in "Unclassified" (COSMOS-80); the user can edit them. */
  initialLabels?: string[];
  /** When set, the dialog opens as a "Duplicate issue" draft pre-filled from
   *  this source item (COSMOS-13). The user edits before creating; comments,
   *  activity, and status are never carried over (they aren't part of create). */
  duplicateSource?: DuplicateSource | null;
  onCreated?: () => void;
}) {
  const isDuplicate = Boolean(duplicateSource);
  // Primitive forms of the two array props, so effects can depend on their
  // VALUES rather than identities that change whenever a parent re-renders or a
  // lazy fetch resolves. See the reset effect below for why that matters.
  const initialLabelsText = (initialLabels ?? []).join(", ");
  const firstProjectId = projects[0]?.id ?? "";
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState(prefilledProjectId ?? "");
  const [workItemTypeId, setWorkItemTypeId] = useState("");
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>("MEDIUM");
  // Multi-assign (FR 1d38496a): full set; first pick becomes the primary.
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [storyPoints, setStoryPoints] = useState("");
  const [dueDate, setDueDate] = useState("");
  // Planned start. REQUIRED alongside the due date: without both, an item can
  // never appear on the timeline, and "why is my ticket missing from the Gantt"
  // is a question the create form is the right place to answer. Enforced HERE
  // rather than in the API, which must stay permissive for imports, seeds and
  // the agent tools — and for the existing rows that predate this rule.
  const [startDate, setStartDate] = useState("");
  // Interval (sprint / PI) the new item joins — optional, project-scoped. Matches
  // the field editable on the detail sheet after creation (COSMOS-64).
  const [intervalId, setIntervalId] = useState<string | null>(null);
  const [intervals, setIntervals] = useState<Interval[]>([]);
  const [description, setDescription] = useState("");
  const [labels, setLabels] = useState("");
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // Status. The dialog used to resolve this silently — first board, first column
  // — with no way to say where the issue should land, which is the one thing the
  // board-local create dialogs it now replaces all offered.
  const [statusColumns, setStatusColumns] = useState<BoardColumn[]>([]);
  const [columnKey, setColumnKey] = useState("");
  // Per-item custom-field values, keyed by CustomField.key. Defs are loaded for
  // the currently-selected project (org-wide defs always included).
  const [customValues, setCustomValues] = useState<Record<string, unknown>>({});
  const [showCustomErrors, setShowCustomErrors] = useState(false);
  const { fields: customFields } = useCustomFields(orgId, projectId || undefined);
  const renderableFields = customFields.filter(isRenderableCustomField);
  // The org's ACTUAL types (built-ins + custom) so the Type picker offers e.g.
  // a "Feature" type. We submit the selected type's id (workItemTypeId) so the
  // server doesn't have to re-derive a sector-prefixed key — which never
  // resolves bare custom keys like "feature".
  const { types: allTypes } = useWorkItemTypes(orgId);
  // Creating only. The shadow types (Milestone, Goal, KPI, Objective, Key
  // Result, Risk) each duplicate a real table, so an item filed as one never
  // reaches the board that owns that concept.
  //
  // Then narrowed to the SELECTED project's sector: the catalogue is org-wide,
  // so a Consulting project was offering Permit, Safety Incident, Course and
  // Production Order among ~49 options. `typesForSector` fails open — a project
  // with no template, or one whose sector hasn't loaded, still sees everything.
  const selectedSector = useMemo(
    () => projects.find((p) => p.id === projectId)?.sector ?? null,
    [projects, projectId],
  );
  const workItemTypes = useMemo(
    () => typesForSector(selectableTypes(allTypes), selectedSector),
    [allTypes, selectedSector],
  );

  // Reset the form each time the dialog opens; default the project. In duplicate
  // mode the seed effect below owns initialization, so skip the reset — otherwise
  // a parent re-render (which recreates `projects`) would blank the pre-filled
  // draft, and the seed effect wouldn't re-run to restore it (COSMOS-13).
  useEffect(() => {
    if (open && !duplicateSource) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTitle("");
      setPriority("MEDIUM");
      setAssigneeIds([]);
      setStoryPoints("");
      setDueDate("");
      setIntervalId(null);
      setDescription("");
      setLabels(initialLabelsText);
      setCustomValues({});
      setShowCustomErrors(false);
      setProjectId(prefilledProjectId ?? firstProjectId);
    }
    // Depend on VALUES, never on the identity of `projects` or `initialLabels`.
    // This effect wipes the form, so anything in its dependency list that gets
    // a fresh identity mid-edit blanks whatever the user has typed. Both are
    // live hazards, not hypotheticals: `NewIssueButton` loads its project list
    // lazily (`enabled: open`), so the array's identity changes moments AFTER
    // the dialog opens — long enough for someone to have started typing — and
    // the Issues view rebuilds `facets.projects` on every refetch. Depending on
    // the array meant the title silently emptied and "Create issue" went back
    // to disabled.
  }, [open, prefilledProjectId, firstProjectId, duplicateSource, initialLabelsText]);

  // The statuses this dialog can file into: the board's own workflow when it was
  // opened from a board, else the project's, pooled across its boards.
  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const boards = await jsonFetch<Board[]>(
          `/api/v1/orgs/${orgId}/projects/${projectId}/boards`,
        );
        if (cancelled) return;
        const own = boardId ? boards.find((b) => b.id === boardId)?.columns : undefined;
        const cols = createStatusOptions(own, boards);
        setStatusColumns(cols);
        setColumnKey((prev) =>
          prev && cols.some((c) => c.key === prev) ? prev : (cols[0]?.key ?? ""),
        );
      } catch {
        // Status stays on the "backlog" fallback below — the boards GET is
        // BOARD_READ-gated, and creation must never hinge on it (COSMOS-86).
        if (!cancelled) {
          setStatusColumns([]);
          setColumnKey("");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, orgId, projectId, boardId]);

  // Default / repair the Type selection once the types load (and re-default
  // when the dialog reopens). Keep a valid selection if one is already chosen.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWorkItemTypeId((prev) =>
      prev && workItemTypes.some((t) => t.id === prev)
        ? prev
        : defaultTypeId(workItemTypes),
    );
  }, [open, workItemTypes]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await jsonFetch<OrgMember[]>(`/api/v1/orgs/${orgId}/members`);
        if (!cancelled) setMembers(data);
      } catch {
        /* assignee optional */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, orgId]);

  // Load the selected project's intervals so a new item can join one at creation
  // (COSMOS-64). Re-runs when the project changes; interval is optional and
  // SPRINT_READ may be denied, so a failure just leaves the picker hidden.
  useEffect(() => {
    if (!open || !projectId) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await jsonFetch<Interval[]>(
          `/api/v1/orgs/${orgId}/projects/${projectId}/intervals`,
        );
        if (!cancelled) setIntervals(data);
      } catch {
        if (!cancelled) setIntervals([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, orgId, projectId]);

  // Duplicate mode (COSMOS-13): when opened to duplicate an existing issue, fetch
  // the source and pre-fill every core field so the user edits a DRAFT and then
  // creates a brand-new issue. This runs after the reset effect above (which
  // fires first, in declaration order), so the fetched values win. Only the
  // create-payload fields are copied — comments, activity, and status are never
  // carried over because they aren't part of the create flow at all.
  useEffect(() => {
    if (!open || !duplicateSource) return;
    let cancelled = false;
    (async () => {
      try {
        const src = await jsonFetch<DuplicateSourceItem>(
          `/api/v1/orgs/${orgId}/projects/${duplicateSource.projectId}/work-items/${duplicateSource.itemId}`,
        );
        if (cancelled) return;
        setShowCustomErrors(false);
        setTitle(`Copy of ${src.title}`);
        setProjectId(duplicateSource.projectId);
        if (src.workItemTypeId) setWorkItemTypeId(src.workItemTypeId);
        setPriority(src.priority);
        setAssigneeIds(
          src.assignees?.length
            ? src.assignees.map((a) => a.userId)
            : src.assigneeId
              ? [src.assigneeId]
              : [],
        );
        setStoryPoints(src.storyPoints != null ? String(src.storyPoints) : "");
        // The date <input> wants YYYY-MM-DD; the source's dueDate is an ISO
        // string, so take its date portion (UTC, matching how it's displayed).
        setDueDate(src.dueDate ? src.dueDate.slice(0, 10) : "");
        setStartDate(src.startDate ? src.startDate.slice(0, 10) : "");
        setIntervalId(src.intervalId ?? null);
        setDescription(src.description ?? "");
        setLabels((src.tags ?? []).join(", "));
        setCustomValues(
          src.customFields && typeof src.customFields === "object"
            ? { ...src.customFields }
            : {},
        );
      } catch (err) {
        if (!cancelled) notifyError(err, "Couldn't load the issue to duplicate.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, duplicateSource, orgId]);

  async function handleSubmit() {
    const trimmed = title.trim();
    if (!trimmed || !projectId || submitting) return;

    // Planned dates are not optional. An item without them cannot be placed on
    // the timeline at all, and the plan is the thing every drift mark is measured
    // against — there is nothing to compare the actuals to without it.
    if (!startDate || !dueDate) {
      toast.error("Set both planned dates — the timeline needs a start and an end.");
      return;
    }
    if (dueDate < startDate) {
      toast.error("Planned end is before planned start.");
      return;
    }

    // Enforce required custom fields before hitting the API.
    const missing = renderableFields.filter(
      (f) => f.required && isCustomFieldEmpty(f, customValues[f.key]),
    );
    if (missing.length > 0) {
      setShowCustomErrors(true);
      toast.error(
        `Fill in required field${missing.length > 1 ? "s" : ""}: ${missing
          .map((f) => f.name)
          .join(", ")}`,
      );
      return;
    }

    setSubmitting(true);
    try {
      // The create API requires a columnKey. It's the user's pick from the Status
      // select, which the effect above populated. Falling back to "backlog" when
      // that list never loaded is load-bearing: the boards GET is BOARD_READ-gated,
      // so a user with ITEM_CREATE but not BOARD_READ can't read it — and creation
      // must not hinge on a request that isn't required to create (COSMOS-86).
      // The server stores columnKey verbatim, so the fallback is safe and the item
      // still appears in the Issues list.
      const submitColumnKey = columnKey || "backlog";
      const tags = labels
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      // Collect non-empty custom-field values into the POST body's customFields.
      const customFieldsBody: Record<string, unknown> = {};
      for (const f of renderableFields) {
        const v = customValues[f.key];
        if (!isCustomFieldEmpty(f, v)) customFieldsBody[f.key] = v;
      }
      const points = storyPoints.trim() === "" ? undefined : Number(storyPoints);
      // The server requires whole-number story points (z.number().int()); a
      // fractional entry would otherwise round-trip to a generic 400 with no
      // hint as to the cause. Catch it here with a specific, actionable message.
      if (points != null && (!Number.isInteger(points) || points < 0)) {
        toast.error("Story points must be a whole number.");
        setSubmitting(false);
        return;
      }

      await jsonFetch(`/api/v1/orgs/${orgId}/projects/${projectId}/work-items`, {
        method: "POST",
        body: JSON.stringify({
          title: trimmed,
          ...(workItemTypeId ? { workItemTypeId } : { type: "TASK" }),
          columnKey: submitColumnKey,
          priority,
          ...(assigneeIds.length ? { assigneeIds } : {}),
          ...(intervalId ? { intervalId } : {}),
          description: description.trim() || null,
          startDate: startDate ? new Date(startDate).toISOString() : null,
          dueDate: dueDate ? new Date(dueDate).toISOString() : null,
          tags: tags.length ? tags : undefined,
          ...(points != null && Number.isFinite(points) ? { storyPoints: points } : {}),
          ...(Object.keys(customFieldsBody).length > 0
            ? { customFields: customFieldsBody }
            : {}),
        }),
      });
      toast.success(`Created "${trimmed}"`);
      onOpenChange(false);
      onCreated?.();
    } catch (err) {
      notifyError(err, "Couldn't create the issue.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isDuplicate ? "Duplicate issue" : "New issue"}</DialogTitle>
          <DialogDescription>
            {isDuplicate
              ? "Pre-filled from the original — edit anything, then create. Comments, activity, and status aren't carried over."
              : "A title, a project and the planned dates are required — everything else is optional."}
          </DialogDescription>
        </DialogHeader>
        <div
          className="space-y-3"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="ci-title">Title</Label>
            <Input
              id="ci-title"
              autoFocus
              placeholder="Summary of the work…"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={submitting}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Project</Label>
              <select
                value={projectId}
                onChange={(e) => {
                  // Intervals are project-scoped — drop any prior selection so we
                  // never submit an interval from a different project (COSMOS-64).
                  setProjectId(e.target.value);
                  setIntervalId(null);
                }}
                className={fieldClass}
                disabled={submitting || !!prefilledProjectId}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.key} · {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Type</Label>
              <select
                value={workItemTypeId}
                onChange={(e) => setWorkItemTypeId(e.target.value)}
                className={fieldClass}
                disabled={submitting || workItemTypes.length === 0}
              >
                {workItemTypes.length === 0 && (
                  <option value="">Loading…</option>
                )}
                {workItemTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Status</Label>
              <select
                aria-label="Status"
                value={columnKey}
                onChange={(e) => setColumnKey(e.target.value)}
                className={fieldClass}
                disabled={submitting || statusColumns.length === 0}
              >
                {statusColumns.length === 0 && <option value="">Loading…</option>}
                {statusColumns.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Priority</Label>
              <select
                value={priority}
                onChange={(e) =>
                  setPriority(e.target.value as (typeof PRIORITIES)[number])
                }
                className={fieldClass}
                disabled={submitting}
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {titleCase(p)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Assignees</Label>
              {/* Multi-assign (FR 1d38496a): check any number; first checked
                  becomes the primary assignee. */}
              <div className="max-h-28 overflow-y-auto rounded-md border border-[var(--border)] p-1.5">
                {members.map((m) => (
                  <label
                    key={m.userId}
                    className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/40"
                  >
                    <input
                      type="checkbox"
                      className="accent-[var(--primary)]"
                      checked={assigneeIds.includes(m.userId)}
                      disabled={submitting}
                      onChange={(e) =>
                        setAssigneeIds((prev) =>
                          e.target.checked
                            ? [...prev, m.userId]
                            : prev.filter((id) => id !== m.userId),
                        )
                      }
                    />
                    {m.user?.displayName ?? m.user?.email ?? m.userId}
                  </label>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Story points</Label>
              <Input
                type="number"
                min={0}
                step={1}
                placeholder="—"
                value={storyPoints}
                onChange={(e) => setStoryPoints(e.target.value)}
                disabled={submitting}
                className="h-9"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="create-planned-start">
                Planned start *
              </Label>
              <input
                id="create-planned-start"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className={fieldClass}
                disabled={submitting}
                required
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="create-planned-end">
                Planned end *
              </Label>
              <input
                id="create-planned-end"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className={fieldClass}
                disabled={submitting}
                required
              />
            </div>
            {/* Interval (sprint / PI) — only when the project has intervals, matching
                the picker on the detail sheet post-creation (COSMOS-64). */}
            {intervals.length > 0 && (
              <div className="space-y-1">
                <Label className="text-xs">Interval</Label>
                <select
                  aria-label="Interval"
                  value={intervalId ?? ""}
                  onChange={(e) => setIntervalId(e.target.value || null)}
                  className={fieldClass}
                  disabled={submitting}
                >
                  <option value="">No interval</option>
                  {intervals.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="ci-desc" className="text-xs">
              Description
            </Label>
            <Textarea
              id="ci-desc"
              rows={3}
              placeholder="Details, acceptance criteria…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={submitting}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="ci-labels" className="text-xs">
              Labels
            </Label>
            <Input
              id="ci-labels"
              placeholder="comma, separated, labels"
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              disabled={submitting}
              className="h-9"
            />
          </div>

          {/* Custom fields defined for this project (org-wide + project-scoped).
              Bindings to specific work-item types are honored on the detail
              sheet, where the resolved type is known; at create time the type
              is resolved server-side, so all renderable fields are shown. */}
          {renderableFields.length > 0 && (
            <div className="grid grid-cols-2 gap-3 border-t pt-3">
              {renderableFields.map((f) => (
                <CustomFieldInput
                  key={f.id}
                  field={f}
                  value={customValues[f.key]}
                  onChange={(v) =>
                    setCustomValues((prev) => ({ ...prev, [f.key]: v }))
                  }
                  disabled={submitting}
                  showRequiredMark
                  invalid={
                    showCustomErrors &&
                    f.required &&
                    isCustomFieldEmpty(f, customValues[f.key])
                  }
                />
              ))}
            </div>
          )}
        </div>
        <DialogFooter className="sm:justify-between">
          <span className="hidden text-[11px] text-muted-foreground sm:inline">
            ⌘↵ to create
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleSubmit()}
              // Gate only on the truly-required fields (title + project), NOT on
              // workItemTypeId: the board quick-create paths never block on the
              // async types fetch and handleSubmit already falls back to the bare
              // "TASK" type when none is chosen. Requiring a type here left the
              // button permanently disabled whenever the org's types were slow /
              // failed to load, so the user could fill the form but never create
              // (COSMOS-86).
              // Planned dates join title + project as the gate. Still NOT the
              // work-item type: the board quick-create paths must not block on
              // the async types fetch, and handleSubmit falls back to a bare
              // "TASK" when none is chosen (COSMOS-86).
              disabled={!title.trim() || !projectId || !startDate || !dueDate || submitting}
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Create issue"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
