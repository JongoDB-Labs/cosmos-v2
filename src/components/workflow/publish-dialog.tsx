"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CircleX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import type { DefinitionIssue } from "@/lib/workflow/definition";
import { WORKFLOW_INVALIDATE, invalidIssues, mapRequired, projectBase, type WorkflowDiff } from "./api";
import { Pick } from "./fields";

/** "N items in X go to [status]" for each status a change drops that still holds items. */
export function MappingFields({
  statuses,
  options,
  value,
  onChange,
  nameOf,
}: {
  statuses: { key: string; items: number }[];
  options: string[];
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  nameOf: (key: string) => string;
}) {
  return (
    <ul className="space-y-2">
      {statuses
        .filter((s) => s.items > 0)
        .map((s) => (
          <li key={s.key} className="flex flex-wrap items-center gap-2 text-sm">
            <span>
              {s.items} item{s.items === 1 ? "" : "s"} in <strong>{nameOf(s.key)}</strong> go to
            </span>
            <Pick
              label={`New status for the items in ${nameOf(s.key)}`}
              value={value[s.key] ?? ""}
              onChange={(to) => onChange({ ...value, [s.key]: to })}
              options={options.map((o) => ({ value: o, label: nameOf(o) }))}
              placeholder="Pick a status…"
            />
          </li>
        ))}
    </ul>
  );
}

export function IssueList({ issues }: { issues: DefinitionIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="space-y-1 text-sm" aria-label="Problems with the draft">
      {issues.map((i, n) => (
        <li key={n} className="flex items-start gap-2">
          {i.severity === "error" ? (
            <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-red-500" aria-label="Error" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-label="Warning" />
          )}
          <span>{i.message}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Publishing the draft: its problems (errors block, warnings don't), what it
 * changes, where the items in dropped statuses go, then the publish itself.
 */
export function PublishDialog({
  orgId,
  projectId,
  workflowId,
  open,
  onOpenChange,
  nameOf,
  assigned,
  draftStatuses,
}: {
  orgId: string;
  projectId: string;
  workflowId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nameOf: (key: string) => string;
  /** Whether anything follows this workflow yet (if not, a publish moves nothing). */
  assigned: boolean;
  /** The draft's statuses: where the items of a dropped one can go. */
  draftStatuses: string[];
}) {
  const base = `${projectBase(orgId, projectId)}/workflows/${workflowId}/publish`;
  const preview = useQuery({
    queryKey: useOrgQueryKey("workflows", projectId, workflowId, "publish-preview"),
    queryFn: () => jsonFetch<{ version: number; issues: DefinitionIssue[]; diff: WorkflowDiff }>(base),
    enabled: open,
    staleTime: 0,
  });
  const [map, setMap] = useState<Record<string, string>>({});
  const [serverIssues, setServerIssues] = useState<DefinitionIssue[] | null>(null);
  const publish = useOrgMutation({
    mutationFn: () => jsonFetch<{ version: number }>(base, { method: "POST", body: JSON.stringify({ migrationMap: map }) }),
    invalidate: WORKFLOW_INVALIDATE,
    onSuccess: (r) => {
      toast.success(`Published version ${r.version}.`);
      setMap({});
      onOpenChange(false);
    },
    onError: (e) => {
      const issues = invalidIssues(e);
      if (issues) return setServerIssues(issues);
      if (mapRequired(e)) return void preview.refetch();
      notifyError(e, "Couldn't publish the workflow.");
    },
  });

  const data = preview.data;
  const issues = serverIssues ?? data?.issues ?? [];
  const errors = issues.filter((i) => i.severity === "error");
  const occupied = (data?.diff.removedStatuses ?? []).filter((s) => s.items > 0);
  const mapped = occupied.every((s) => map[s.key]);
  const d = data?.diff;

  return (
    <Dialog open={open} onOpenChange={(o) => { setServerIssues(null); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Publish version {data?.version ?? ""}</DialogTitle>
          <DialogDescription>
            {assigned
              ? "Every status change on the items this workflow governs follows it from the moment it is published."
              : "Nothing follows this workflow yet: assign it to the project or a type once it is published."}
          </DialogDescription>
        </DialogHeader>
        {preview.isLoading && <p className="text-sm text-muted-foreground">Checking the draft…</p>}
        {data && (
          <div className="space-y-4">
            <IssueList issues={issues} />
            {d && (d.addedStatuses.length + d.removedStatuses.length + d.addedTransitions.length + d.removedTransitions.length + d.changedTransitions.length > 0) && (
              <div className="space-y-1 text-sm">
                <p className="font-medium">What changes</p>
                <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
                  {d.addedStatuses.length > 0 && <li>Adds {d.addedStatuses.map(nameOf).join(", ")}</li>}
                  {d.removedStatuses.length > 0 && <li>Drops {d.removedStatuses.map((s) => nameOf(s.key)).join(", ")}</li>}
                  {d.addedTransitions.length > 0 && <li>New transitions: {d.addedTransitions.map((t) => t.name).join(", ")}</li>}
                  {d.removedTransitions.length > 0 && <li>Removed transitions: {d.removedTransitions.map((t) => t.name).join(", ")}</li>}
                  {d.changedTransitions.length > 0 && <li>Changed transitions: {d.changedTransitions.map((t) => t.name).join(", ")}</li>}
                </ul>
              </div>
            )}
            {occupied.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Where their items go</p>
                <MappingFields
                  statuses={occupied}
                  options={draftStatuses}
                  value={map}
                  onChange={setMap}
                  nameOf={nameOf}
                />
                <p className="text-xs text-muted-foreground">They move in the background after the publish, with the dates a move sets, and no notifications.</p>
              </div>
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => publish.mutate()} disabled={!data || errors.length > 0 || !mapped || publish.isPending}>
            {publish.isPending ? "Publishing…" : "Publish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
