"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Workflow } from "lucide-react";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { SectionCard } from "@/components/ui/section-card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import type { WorkflowSettings } from "@/lib/workflow/settings";

/**
 * The org's workflow settings: the parent guard, and the resolutions a step
 * into Done or Cancelled offers. Shown to whoever may manage workflows.
 */
export function WorkflowSettingsCard({ orgId }: { orgId: string }) {
  const { data } = useQuery({
    queryKey: useOrgQueryKey("workflow-settings"),
    queryFn: () => jsonFetch<WorkflowSettings & { canManage: boolean }>(`/api/v1/orgs/${orgId}/workflow-settings`),
  });
  const save = useOrgMutation({
    mutationFn: (patch: Partial<WorkflowSettings>) =>
      jsonFetch(`/api/v1/orgs/${orgId}/workflow-settings`, { method: "PUT", body: JSON.stringify(patch) }),
    invalidate: [["workflow-settings"]],
    onError: (e) => notifyError(e, "Couldn't change the setting."),
  });
  if (!data?.canManage) return null;
  return (
    <SectionCard icon={Workflow} title="Workflows" description="How status changes behave across every project.">
      <div className="space-y-4">
        <label className="flex items-start justify-between gap-4 text-sm">
          <span>
            Block finishing a parent with open sub-items
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {"A parent can't move to a Done status while any of its sub-items is still open, from the board, the detail panel, bulk edits, the API and the assistant alike. Cancelled sub-items don't block."}
            </span>
          </span>
          <ToggleSwitch
            aria-label="Block finishing a parent with open sub-items"
            checked={data.blockParentWithOpenChildren}
            onCheckedChange={(v) => save.mutate({ blockParentWithOpenChildren: v })}
            disabled={save.isPending}
          />
        </label>
        <ResolutionsEditor
          key={data.resolutions.join("\n")}
          resolutions={data.resolutions}
          pending={save.isPending}
          onSave={(resolutions) => save.mutate({ resolutions })}
        />
      </div>
    </SectionCard>
  );
}

function ResolutionsEditor({
  resolutions,
  pending,
  onSave,
}: {
  resolutions: string[];
  pending: boolean;
  onSave: (resolutions: string[]) => void;
}) {
  const [draft, setDraft] = useState(resolutions.join(", "));
  const next = [...new Set(draft.split(",").map((r) => r.trim()).filter(Boolean))];
  const changed = next.join("\n") !== resolutions.join("\n");
  return (
    <div className="space-y-1 text-sm">
      <label htmlFor="workflow-resolutions">Resolutions</label>
      <span className="block text-xs text-muted-foreground">
        What a step into Done or Cancelled can record as the outcome, separated by commas.
      </span>
      <div className="flex gap-2">
        <Input id="workflow-resolutions" value={draft} onChange={(e) => setDraft(e.target.value)} disabled={pending} />
        <Button size="sm" onClick={() => onSave(next)} disabled={pending || !changed || next.length === 0}>
          Save
        </Button>
      </div>
    </div>
  );
}
