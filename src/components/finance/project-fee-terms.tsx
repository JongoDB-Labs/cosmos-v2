"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseMarkupInput } from "@/components/finance/markup-cell";
import { MAX_MARKUP_PCT } from "@/lib/finance/markup";

type Terms = {
  markupPct: number | null;
  effectiveMarkup: { pct: number; source: "project" | "org" };
  canManage: boolean;
};

/**
 * A project's fee terms: its markup on reimbursable costs, overriding the
 * org's default for this project's bills. Shown to finance readers only; the
 * page renders it only for them, and it renders nothing if the read is refused.
 */
export function ProjectFeeTerms({ orgId, projectId }: { orgId: string; projectId: string }) {
  const url = `/api/v1/orgs/${orgId}/projects/${projectId}/fee-terms`;
  const q = useQuery({
    queryKey: useOrgQueryKey("project-fee-terms", projectId),
    queryFn: () => jsonFetch<Terms>(url),
  });
  if (!q.data) return null;
  // Keyed on the saved value, so a save re-seeds the field.
  return <Form key={String(q.data.markupPct)} projectId={projectId} url={url} saved={q.data} />;
}

function Form({ projectId, url, saved }: { projectId: string; url: string; saved: Terms }) {
  const [draft, setDraft] = useState(saved.markupPct === null ? "" : String(saved.markupPct));

  const save = useOrgMutation({
    mutationFn: (markupPct: number | null) =>
      jsonFetch(url, { method: "PUT", body: JSON.stringify({ markupPct }) }),
    invalidate: [["project-fee-terms", projectId], ["bills"]],
    onSuccess: () => toast.success("Fee terms saved"),
  });

  const value = parseMarkupInput(draft);
  const dirty = value !== undefined && value !== saved.markupPct;
  const org = saved.effectiveMarkup.source === "org" ? saved.effectiveMarkup.pct : null;

  return (
    <section aria-label="Fee terms" className="mt-8 rounded-lg border">
      <div className="flex flex-wrap items-end justify-between gap-4 px-4 py-3">
        <div className="min-w-0 flex-1 basis-64">
          <label htmlFor="project-markup" className="text-sm font-medium">
            Markup on reimbursable costs (%)
          </label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Bills on this project are re-billed to the client at cost plus this markup, unless a bill sets its own.
            Leave it empty to use the organization&apos;s default
            {org !== null ? ` (currently ${org}%)` : ""}.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            id="project-markup"
            type="number"
            min={0}
            max={MAX_MARKUP_PCT}
            step="0.01"
            inputMode="decimal"
            placeholder="Org default"
            className="h-9 w-32"
            value={draft}
            disabled={!saved.canManage || save.isPending}
            onChange={(e) => setDraft(e.target.value)}
          />
          {saved.canManage && (
            <Button size="sm" disabled={!dirty || save.isPending} onClick={() => value !== undefined && save.mutate(value)}>
              Save
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
