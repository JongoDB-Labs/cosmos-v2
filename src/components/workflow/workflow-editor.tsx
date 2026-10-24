"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Plus } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { useCustomFields } from "@/hooks/use-custom-fields";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { freshTransitionId, removeTransition, upsertTransition } from "@/lib/workflow/draft-edit";
import type { DefinitionIssue, TransitionSpec, VersionLayout, WorkflowDefinition } from "@/lib/workflow/definition";
import { cn } from "@/lib/utils";
import { WORKFLOW_INVALIDATE, invalidIssues, projectBase, useProjectStatusesFull, useWorkflow } from "./api";
import { Pick } from "./fields";
import { IssueList, PublishDialog } from "./publish-dialog";
import { SimulatePanel } from "./simulate-panel";
import { StatusesPanel } from "./statuses-panel";
import { TransitionMatrix } from "./transition-matrix";
import { TransitionPanel } from "./transition-panel";

// React Flow is ~150 kB: only for those who open the diagram.
const WorkflowCanvas = dynamic(() => import("./workflow-canvas").then((m) => m.WorkflowCanvas), {
  ssr: false,
  loading: () => <Skeleton className="h-[560px] w-full" />,
});

type View = "matrix" | "canvas" | "statuses" | "simulate" | "history";
const VIEWS: { id: View; label: string }[] = [
  { id: "matrix", label: "Transitions" },
  { id: "canvas", label: "Diagram" },
  { id: "statuses", label: "Statuses" },
  { id: "simulate", label: "Simulate" },
  { id: "history", label: "History" },
];

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved"; issues: DefinitionIssue[] } | { kind: "error"; issues: DefinitionIssue[] | null };

/**
 * One workflow's editor. The draft lives here and autosaves (it is a draft:
 * nothing changes for anyone until it is published). Every view edits the
 * same draft through src/lib/workflow/draft-edit.ts.
 */
export function WorkflowEditor({
  orgId,
  orgSlug,
  projectId,
  projectKey,
  workflowId,
  canManage,
}: {
  orgId: string;
  orgSlug: string;
  projectId: string;
  projectKey: string;
  workflowId: string;
  canManage: boolean;
}) {
  const workflow = useWorkflow(orgId, projectId, workflowId);
  const statuses = useProjectStatusesFull(orgId, projectId);
  const { fields } = useCustomFields(orgId, projectId);
  const customFields = useMemo(() => fields.map((f) => ({ key: f.key, name: f.name })), [fields]);

  if (workflow.isError || statuses.isError) {
    return <LoadError title="Couldn't load the workflow" onRetry={() => { void workflow.refetch(); void statuses.refetch(); }} />;
  }
  if (!workflow.data || !statuses.data) return <Skeleton className="h-96 w-full" />;
  const version = workflow.data.draft ?? workflow.data.published;
  if (!version) return <LoadError title="This workflow has no version" />;
  return (
    <Loaded
      key={workflowId}
      orgId={orgId}
      orgSlug={orgSlug}
      projectId={projectId}
      projectKey={projectKey}
      workflowId={workflowId}
      canManage={canManage}
      detail={workflow.data}
      initial={version.definition}
      layout={version.layout ?? {}}
      statuses={statuses.data}
      customFields={customFields}
      reload={async () => {
        const r = await workflow.refetch();
        return (r.data?.draft ?? r.data?.published)?.definition ?? null;
      }}
    />
  );
}

function Loaded({
  orgId,
  orgSlug,
  projectId,
  projectKey,
  workflowId,
  canManage,
  detail,
  initial,
  layout,
  statuses,
  customFields,
  reload,
}: {
  orgId: string;
  orgSlug: string;
  projectId: string;
  projectKey: string;
  workflowId: string;
  canManage: boolean;
  detail: NonNullable<ReturnType<typeof useWorkflow>["data"]>;
  initial: WorkflowDefinition;
  layout: VersionLayout;
  statuses: NonNullable<ReturnType<typeof useProjectStatusesFull>["data"]>;
  customFields: { key: string; name: string }[];
  /** Fetch the workflow again; the definition the editor should now hold. */
  reload: () => Promise<WorkflowDefinition | null>;
}) {
  const base = `${projectBase(orgId, projectId)}/workflows/${workflowId}`;
  const qc = useQueryClient();
  const listKey = useOrgQueryKey("workflows", projectId);
  const [def, setDef] = useState<WorkflowDefinition>(initial);
  const [lay, setLay] = useState<VersionLayout>(layout);
  const [view, setView] = useState<View>("matrix");
  const [editing, setEditing] = useState<TransitionSpec | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readOnly = !canManage;

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const persist = async (next: WorkflowDefinition, nextLayout: VersionLayout) => {
    setSave({ kind: "saving" });
    try {
      const r = await jsonFetch<{ version: number; issues: DefinitionIssue[] }>(`${base}/draft`, {
        method: "PUT",
        body: JSON.stringify({ definition: next, layout: nextLayout }),
      });
      setSave({ kind: "saved", issues: r.issues });
      // The badges and the list show the draft; the editor keeps its own copy.
      void qc.invalidateQueries({ queryKey: listKey });
    } catch (e) {
      const issues = invalidIssues(e);
      setSave({ kind: "error", issues });
      if (!issues) notifyError(e, "Couldn't save the draft.");
    }
  };

  const schedule = (next: WorkflowDefinition, nextLayout: VersionLayout) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void persist(next, nextLayout), 600);
  };
  const change = (next: WorkflowDefinition) => {
    if (readOnly) return;
    setDef(next);
    schedule(next, lay);
  };
  const moveNodes = (nodes: NonNullable<VersionLayout["nodes"]>) => {
    if (readOnly) return;
    const next = { ...lay, nodes };
    setLay(next);
    schedule(def, next);
  };

  const byKey = new Map(statuses.map((s) => [s.key, s]));
  const nameOf = (key: string) => byKey.get(key)?.name ?? key;
  const inWorkflow = def.statuses.map((s) => ({ key: s.key, name: nameOf(s.key), color: byKey.get(s.key)?.color ?? "#94a3b8" }));
  const issues = save.kind === "saved" || save.kind === "error" ? (save.issues ?? []) : [];
  const errors = issues.filter((i) => i.severity === "error");

  const meta = useOrgMutation({
    mutationFn: (body: Record<string, unknown>) => jsonFetch(base, { method: "PATCH", body: JSON.stringify(body) }),
    invalidate: WORKFLOW_INVALIDATE,
    onError: (e) => notifyError(e, "Couldn't change the workflow."),
  });
  const discard = useOrgMutation({
    mutationFn: () => jsonFetch(`${base}/draft`, { method: "DELETE" }),
    invalidate: WORKFLOW_INVALIDATE,
    onSuccess: async () => {
      const next = await reload();
      if (next) setDef(next);
      setSave({ kind: "idle" });
      toast.success("Draft discarded.");
    },
    onError: (e) => notifyError(e, "Couldn't discard the draft."),
  });
  const restore = useOrgMutation({
    mutationFn: (version: number) => jsonFetch(`${base}/versions/${version}/restore`, { method: "POST" }),
    invalidate: WORKFLOW_INVALIDATE,
    onSuccess: async () => {
      const next = await reload();
      if (next) setDef(next);
      toast.success("The draft now holds that version. Publish it to bring it back.");
    },
    onError: (e) => notifyError(e, "Couldn't restore that version."),
  });

  const addTransition = () => {
    const to = def.statuses[0]?.key ?? "";
    setEditing({ id: freshTransitionId(def, "new-transition"), name: "New transition", from: def.statuses.slice(1).map((s) => s.key), to });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/${orgSlug}/projects/${projectKey}/settings/workflows`} className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
          <ArrowLeft className="mr-1 h-4 w-4" aria-hidden />
          Workflows
        </Link>
        <WorkflowName name={detail.name} disabled={readOnly} onRename={(name) => meta.mutate({ name })} />
        <Badge variant={detail.published ? "done" : "neutral"}>
          {detail.published ? `Published v${detail.published.version}` : "Not published"}
        </Badge>
        {detail.draft && <Badge variant="review">Draft v{detail.draft.version}</Badge>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SaveIndicator state={save} />
          <Pick
            label="Enforcement"
            value={detail.enforcement}
            onChange={(enforcement) => meta.mutate({ enforcement })}
            options={[
              { value: "ENFORCE", label: "Enforce" },
              { value: "SHADOW", label: "Shadow (record only)" },
            ]}
            disabled={readOnly}
            className="min-w-40"
          />
          {canManage && detail.draft && detail.published && (
            <Button variant="outline" size="sm" onClick={() => discard.mutate()} disabled={discard.isPending}>
              Discard draft
            </Button>
          )}
          {canManage && (
            <Button size="sm" onClick={() => setPublishing(true)} disabled={!detail.draft || save.kind === "saving" || errors.length > 0}>
              Publish…
            </Button>
          )}
        </div>
      </div>

      {issues.length > 0 && (
        <div className="rounded-md border bg-muted/20 p-3">
          <IssueList issues={issues} />
        </div>
      )}

      <div role="tablist" aria-label="Workflow views" className="flex flex-wrap gap-1 border-b">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            id={`wf-tab-${v.id}`}
            aria-selected={view === v.id}
            aria-controls={`wf-panel-${v.id}`}
            onClick={() => setView(v.id)}
            className={cn(
              "-mb-px border-b-2 px-3 py-1.5 text-sm",
              view === v.id ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {v.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`wf-panel-${view}`} aria-labelledby={`wf-tab-${view}`}>
        {view === "matrix" && (
          <div className="space-y-3">
            <TransitionMatrix
              definition={def}
              statuses={inWorkflow}
              onChange={change}
              onEditTransition={(id) => setEditing(def.transitions.find((t) => t.id === id) ?? null)}
              readOnly={readOnly}
            />
            {!readOnly && (
              <Button variant="outline" size="sm" onClick={addTransition}>
                <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
                Add transition
              </Button>
            )}
            <TransitionList transitions={def.transitions} nameOf={nameOf} onEdit={setEditing} />
          </div>
        )}
        {view === "canvas" && (
          <WorkflowCanvas
            definition={def}
            statuses={def.statuses.map((st) => ({
              key: st.key,
              name: nameOf(st.key),
              color: byKey.get(st.key)?.color ?? "#94a3b8",
              category: byKey.get(st.key)?.category ?? "TODO",
            }))}
            layout={lay}
            onChange={change}
            onLayoutChange={moveNodes}
            onEditTransition={(id) => setEditing(def.transitions.find((t) => t.id === id) ?? null)}
            readOnly={readOnly}
          />
        )}
        {view === "statuses" && (
          <StatusesPanel orgId={orgId} projectId={projectId} definition={def} statuses={statuses} onChange={change} readOnly={readOnly} />
        )}
        {view === "simulate" && <SimulatePanel orgId={orgId} projectId={projectId} definition={def} nameOf={nameOf} />}
        {view === "history" && (
          <ul className="space-y-1.5 text-sm" aria-label="Versions">
            {detail.versions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
                <span className="font-medium">v{v.version}</span>
                <Badge variant={v.state === "PUBLISHED" ? "done" : v.state === "DRAFT" ? "review" : "neutral"}>{v.state.toLowerCase()}</Badge>
                <span className="text-muted-foreground">{v.publishedAt ? `published ${new Date(v.publishedAt).toLocaleString()}` : `started ${new Date(v.createdAt).toLocaleString()}`}</span>
                {canManage && v.state !== "DRAFT" && (
                  <Button className="ml-auto" variant="outline" size="sm" onClick={() => restore.mutate(v.version)} disabled={restore.isPending}>
                    Restore into the draft
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <TransitionPanel
        transition={editing}
        statuses={inWorkflow}
        customFields={customFields}
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        readOnly={readOnly}
        onSave={(t, previousId) => {
          change(upsertTransition(def, t, previousId));
          setEditing(null);
        }}
        onDelete={(id) => {
          change(removeTransition(def, id));
          setEditing(null);
        }}
      />
      {canManage && (
        <PublishDialog
          orgId={orgId}
          projectId={projectId}
          workflowId={workflowId}
          open={publishing}
          onOpenChange={setPublishing}
          nameOf={nameOf}
          assigned={detail.assignedTo.length > 0}
          draftStatuses={def.statuses.map((s) => s.key)}
        />
      )}
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  const text =
    state.kind === "saving" ? "Saving draft…" : state.kind === "saved" ? "Draft saved" : state.kind === "error" ? "Not saved" : "";
  return (
    <span role="status" aria-live="polite" className={cn("text-xs text-muted-foreground", state.kind === "error" && "text-red-500")}>
      {text}
    </span>
  );
}

function WorkflowName({ name, disabled, onRename }: { name: string; disabled: boolean; onRename: (name: string) => void }) {
  const [value, setValue] = useState(name);
  return (
    <Input
      aria-label="Workflow name"
      className="h-9 w-64 text-base font-semibold"
      value={value}
      disabled={disabled}
      maxLength={80}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        const next = value.trim();
        if (next && next !== name) onRename(next);
        else setValue(name);
      }}
    />
  );
}

/** Every transition, with what it does: the list that names what the matrix only ticks. */
function TransitionList({
  transitions,
  nameOf,
  onEdit,
}: {
  transitions: TransitionSpec[];
  nameOf: (key: string) => string;
  onEdit: (t: TransitionSpec) => void;
}) {
  if (transitions.length === 0) return <p className="text-sm text-muted-foreground">No transitions: items can&apos;t move.</p>;
  return (
    <ul className="divide-y rounded-md border text-sm" aria-label="Transitions">
      {transitions.map((t) => {
        const rules = [t.restrict && "restricted", t.input?.length && `asks for ${t.input.length}`, t.validate?.length && `${t.validate.length} check${t.validate.length === 1 ? "" : "s"}`, t.actions?.length && `${t.actions.length} action${t.actions.length === 1 ? "" : "s"}`, t.hidden && "hidden"].filter(Boolean);
        return (
          <li key={t.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <button type="button" className="font-medium hover:underline" onClick={() => onEdit(t)}>
              {t.name}
            </button>
            <span className="text-muted-foreground">
              {t.from === "*" ? "any status" : t.from.map(nameOf).join(", ")} → {nameOf(t.to)}
            </span>
            {rules.length > 0 && <span className="text-xs text-muted-foreground">({rules.join(", ")})</span>}
          </li>
        );
      })}
    </ul>
  );
}
