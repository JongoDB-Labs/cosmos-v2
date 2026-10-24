"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import {
  WORKFLOW_INVALIDATE,
  mapRequired,
  projectBase,
  useProjectStatusesFull,
  useProjectWorkflows,
  useWorkflowMigration,
  useWorkflowTemplates,
  type MapRequired,
} from "./api";
import { Pick } from "./fields";
import { MappingFields } from "./publish-dialog";

const OPEN = "__open__";
const DEFAULT = "__default__";

type WorkItemType = { id: string; name: string };

/**
 * A project's workflows: which one each type follows, the workflows
 * themselves, new ones (from the open workflow, a copy or an org template),
 * and what is still moving after a publish or reassignment.
 */
export function WorkflowsOverview({
  orgId,
  orgSlug,
  projectId,
  projectKey,
  canManage,
  canManageTemplates,
}: {
  orgId: string;
  orgSlug: string;
  projectId: string;
  projectKey: string;
  canManage: boolean;
  canManageTemplates: boolean;
}) {
  const list = useProjectWorkflows(orgId, projectId);
  const statuses = useProjectStatusesFull(orgId, projectId);
  const migration = useWorkflowMigration(orgId, projectId);
  const types = useQuery({
    queryKey: useOrgQueryKey("work-item-types"),
    queryFn: async () => {
      const body = await jsonFetch<unknown>(`/api/v1/orgs/${orgId}/work-item-types`);
      return (Array.isArray(body) ? body : ((body as { data?: WorkItemType[] }).data ?? [])) as WorkItemType[];
    },
  });
  const [creating, setCreating] = useState(false);
  const nameOf = (key: string) => statuses.data?.find((s) => s.key === key)?.name ?? key;

  if (list.isError) return <LoadError title="Couldn't load the workflows" onRetry={() => void list.refetch()} />;
  if (!list.data) return <Skeleton className="h-64 w-full" />;
  const { workflows, assignments } = list.data;
  const editorHref = (id: string) => `/${orgSlug}/projects/${projectKey}/settings/workflows/${id}`;
  const pending = (migration.data ?? []).filter((m) => m.items > 0);

  return (
    <div className="space-y-8">
      {pending.length > 0 && (
        <div role="status" className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <p className="font-medium">Items still moving to their new statuses</p>
          <ul className="mt-1 list-disc pl-5 text-muted-foreground">
            {pending.map((m, i) => (
              <li key={i}>
                {m.items} in {nameOf(m.from)} {m.to ? `→ ${nameOf(m.to)}` : "have no status to go to: move them by hand"}
              </li>
            ))}
          </ul>
        </div>
      )}

      <section aria-labelledby="wf-assign-heading" className="space-y-3">
        <h3 id="wf-assign-heading" className="text-lg font-semibold">Which workflow each type follows</h3>
        <p className="text-sm text-muted-foreground">
          A type without its own follows the project default; the open workflow lets anything move anywhere, as boards always have.
        </p>
        <AssignmentTable
          orgId={orgId}
          projectId={projectId}
          workflows={workflows.filter((w) => w.published)}
          assignments={assignments}
          types={types.data ?? []}
          nameOf={nameOf}
          canManage={canManage}
        />
      </section>

      <section aria-labelledby="wf-list-heading" className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h3 id="wf-list-heading" className="text-lg font-semibold">Workflows</h3>
          {canManage && (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="mr-1 h-4 w-4" aria-hidden />
              New workflow
            </Button>
          )}
        </div>
        {workflows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            This project runs the open workflow. Create one to restrict moves, ask for details on the way or check them.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {workflows.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <Link href={editorHref(w.id)} className="font-medium hover:underline">
                  {w.name}
                </Link>
                <Badge variant={w.published ? "done" : "neutral"}>{w.published ? `v${w.published.version}` : "not published"}</Badge>
                {w.draft && <Badge variant="review">draft</Badge>}
                {w.enforcement === "SHADOW" && <Badge variant="discovery">shadow</Badge>}
                <span className="text-muted-foreground">
                  {w.assignedTo.length === 0
                    ? "not in use"
                    : `used by ${w.assignedTo.map((t) => (t ? (types.data?.find((x) => x.id === t)?.name ?? "a type") : "the project")).join(", ")}`}
                </span>
                {canManageTemplates && w.published && <SaveAsTemplate orgId={orgId} workflowId={w.id} name={w.name} />}
                {/* Only a workflow nothing follows: the server refuses one in use (409),
                    and offering the button there would only lead to that refusal. */}
                {canManage && w.assignedTo.length === 0 && (
                  <DeleteWorkflow
                    orgId={orgId}
                    projectId={projectId}
                    workflowId={w.id}
                    name={w.name}
                    className={canManageTemplates && w.published ? undefined : "ml-auto"}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {creating && (
        <NewWorkflowDialog
          orgId={orgId}
          projectId={projectId}
          workflows={workflows.map((w) => ({ id: w.id, name: w.name }))}
          onClose={() => setCreating(false)}
          editorHref={editorHref}
        />
      )}
    </div>
  );
}

function AssignmentTable({
  orgId,
  projectId,
  workflows,
  assignments,
  types,
  nameOf,
  canManage,
}: {
  orgId: string;
  projectId: string;
  workflows: { id: string; name: string }[];
  assignments: { workItemTypeId: string | null; workflowId: string }[];
  types: WorkItemType[];
  nameOf: (key: string) => string;
  canManage: boolean;
}) {
  const [asking, setAsking] = useState<{ workItemTypeId: string | null; workflowId: string | null; need: MapRequired } | null>(null);
  const [map, setMap] = useState<Record<string, string>>({});
  const assign = useOrgMutation({
    mutationFn: (body: { workItemTypeId: string | null; workflowId: string | null; migrationMap?: Record<string, string> }) =>
      jsonFetch(`${projectBase(orgId, projectId)}/workflow/assignments`, { method: "PUT", body: JSON.stringify(body) }),
    invalidate: WORKFLOW_INVALIDATE,
    onSuccess: () => {
      setAsking(null);
      setMap({});
      toast.success("Workflow assigned.");
    },
    onError: (e, body) => {
      const need = mapRequired(e);
      if (need) return setAsking({ workItemTypeId: body.workItemTypeId, workflowId: body.workflowId, need });
      notifyError(e, "Couldn't assign the workflow.");
    },
  });
  const current = (typeId: string | null) => assignments.find((a) => a.workItemTypeId === typeId)?.workflowId;
  const rows: { id: string | null; name: string }[] = [{ id: null, name: "Project default" }, ...types];
  const options = (typeId: string | null) => [
    { value: typeId ? DEFAULT : OPEN, label: typeId ? "Project default" : "Open workflow" },
    ...workflows.map((w) => ({ value: w.id, label: w.name })),
  ];

  return (
    <>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm" aria-label="Workflow per type">
          <thead className="bg-muted/40 text-left text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Type</th>
              <th scope="col" className="px-3 py-2 font-medium">Workflow</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id ?? "default"} className="border-t">
                <th scope="row" className="px-3 py-2 text-left font-normal">{r.name}</th>
                <td className="px-3 py-2">
                  <Pick
                    label={`Workflow for ${r.name}`}
                    value={current(r.id) ?? (r.id ? DEFAULT : OPEN)}
                    onChange={(v) => assign.mutate({ workItemTypeId: r.id, workflowId: v === OPEN || v === DEFAULT ? null : v })}
                    options={options(r.id)}
                    disabled={!canManage || assign.isPending}
                    className="min-w-56"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Dialog open={asking !== null} onOpenChange={(o) => !o && setAsking(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Where should these items go?</DialogTitle>
            <DialogDescription>The new workflow doesn&apos;t use some statuses these items are in. They move in the background.</DialogDescription>
          </DialogHeader>
          {asking && <MappingFields statuses={asking.need.statuses} options={asking.need.options} value={map} onChange={setMap} nameOf={nameOf} />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setAsking(null)}>
              Cancel
            </Button>
            <Button
              disabled={!asking || asking.need.statuses.some((s) => s.items > 0 && !map[s.key]) || assign.isPending}
              onClick={() => asking && assign.mutate({ workItemTypeId: asking.workItemTypeId, workflowId: asking.workflowId, migrationMap: map })}
            >
              Assign and move them
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function NewWorkflowDialog({
  orgId,
  projectId,
  workflows,
  onClose,
  editorHref,
}: {
  orgId: string;
  projectId: string;
  workflows: { id: string; name: string }[];
  onClose: () => void;
  editorHref: (id: string) => string;
}) {
  const router = useRouter();
  const templates = useWorkflowTemplates(orgId);
  const [name, setName] = useState("");
  const [from, setFrom] = useState("open");
  const create = useOrgMutation({
    mutationFn: () => {
      const source = from === "open"
        ? { kind: "open" as const }
        : from.startsWith("copy:")
          ? { kind: "copy" as const, workflowId: from.slice(5) }
          : { kind: "template" as const, templateId: from.slice(9) };
      return jsonFetch<{ id: string }>(`${projectBase(orgId, projectId)}/workflows`, {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), from: source }),
      });
    },
    invalidate: WORKFLOW_INVALIDATE,
    onSuccess: ({ id }) => {
      // Close first: the route keeps this page's state, and a dialog left open
      // would greet the person coming back.
      onClose();
      router.push(editorHref(id));
    },
    onError: (e) => notifyError(e, "Couldn't create the workflow."),
  });
  const sources = [
    { value: "open", label: "The open workflow (how the project works today)" },
    ...workflows.map((w) => ({ value: `copy:${w.id}`, label: `A copy of ${w.name}` })),
    ...(templates.data ?? []).map((t) => ({ value: `template:${t.id}`, label: `Template: ${t.name}` })),
  ];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New workflow</DialogTitle>
          <DialogDescription>It starts as a draft, and nothing follows it until you publish and assign it.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <label className="grid gap-1 text-sm">
            <span>Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
          </label>
          <div className="grid gap-1 text-sm">
            <span>Start from</span>
            <Pick label="Start from" value={from} onChange={setFrom} options={sources} className="w-full" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteWorkflow({
  orgId,
  projectId,
  workflowId,
  name,
  className,
}: {
  orgId: string;
  projectId: string;
  workflowId: string;
  name: string;
  className?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const remove = useOrgMutation({
    mutationFn: () => jsonFetch(`${projectBase(orgId, projectId)}/workflows/${workflowId}`, { method: "DELETE" }),
    invalidate: WORKFLOW_INVALIDATE,
    onSuccess: () => {
      setConfirming(false);
      toast.success(`Deleted "${name}".`);
    },
    onError: (e) => notifyError(e, "Couldn't delete the workflow."),
  });
  return (
    <>
      <Button className={className} variant="ghost" size="sm" aria-label={`Delete workflow ${name}`} onClick={() => setConfirming(true)}>
        Delete…
      </Button>
      <Dialog open={confirming} onOpenChange={(o) => !o && setConfirming(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this workflow?</DialogTitle>
            <DialogDescription>
              {`“${name}” and all of its versions will be deleted. No type follows it, so no item moves. This can’t be undone.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)} disabled={remove.isPending}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
              {remove.isPending ? "Deleting…" : "Delete workflow"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function SaveAsTemplate({ orgId, workflowId, name }: { orgId: string; workflowId: string; name: string }) {
  const save = useOrgMutation({
    mutationFn: () =>
      jsonFetch(`/api/v1/orgs/${orgId}/workflow-templates`, { method: "POST", body: JSON.stringify({ fromWorkflowId: workflowId, name }) }),
    invalidate: [["workflow-templates"]],
    onSuccess: () => toast.success(`Saved "${name}" as an org template.`),
    onError: (e) => notifyError(e, "Couldn't save the template."),
  });
  return (
    <Button className="ml-auto" variant="ghost" size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
      Save as template
    </Button>
  );
}
