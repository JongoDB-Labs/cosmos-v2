"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_MARKUP_PCT, type FinanceSettings } from "@/lib/finance/markup";

type Payload = FinanceSettings & { canManage: boolean };

/** The org's finance settings, shared by every screen that needs them (one fetch per org). */
export function useFinanceSettings(orgId: string) {
  return useQuery({
    queryKey: useOrgQueryKey("finance-settings"),
    queryFn: () => jsonFetch<Payload>(`/api/v1/orgs/${orgId}/finance/settings`),
  });
}

/**
 * The org's default markup on reimbursable costs, and how an invoice shows a
 * marked-up cost. Editable with finance-manage permission; read-only otherwise.
 * Renders nothing until loaded, or for someone who can't read finance.
 */
export function FinanceSettingsCard({ orgId }: { orgId: string }) {
  const q = useFinanceSettings(orgId);
  if (!q.data) return null;
  // Keyed on the saved values, so a save (or another tab's) re-seeds the form.
  const { reimbursableMarkupPct, reimbursableLines } = q.data;
  return <Form key={`${reimbursableMarkupPct}:${reimbursableLines}`} orgId={orgId} saved={q.data} />;
}

function Form({ orgId, saved }: { orgId: string; saved: Payload }) {
  const [pct, setPct] = useState(String(saved.reimbursableMarkupPct));
  const [lines, setLines] = useState<FinanceSettings["reimbursableLines"]>(saved.reimbursableLines);

  const save = useOrgMutation({
    mutationFn: (body: FinanceSettings) =>
      jsonFetch<FinanceSettings>(`/api/v1/orgs/${orgId}/finance/settings`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    invalidate: [["finance-settings"], ["bills"]],
    onSuccess: () => toast.success("Finance settings saved"),
  });

  const canManage = saved.canManage;
  const n = Number(pct);
  const valid = pct.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= MAX_MARKUP_PCT;
  const dirty = valid && (n !== saved.reimbursableMarkupPct || lines !== saved.reimbursableLines);

  return (
    <section
      aria-label="Reimbursable costs"
      className="flex flex-wrap items-end gap-x-6 gap-y-3 rounded-lg border border-[var(--border)] px-4 py-3 text-sm"
    >
      <div className="min-w-0 flex-1 basis-64">
        <div className="font-medium">Reimbursable costs</div>
        <p className="mt-0.5 text-xs text-[var(--text-muted)]">
          A bill on a project is re-billed to the client at cost plus this markup, unless the project or the bill sets
          its own. The bill keeps the vendor&apos;s exact amount.
        </p>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-[var(--text-muted)]">Default markup (%)</span>
        <Input
          id="finance-markup"
          type="number"
          min={0}
          max={MAX_MARKUP_PCT}
          step="0.01"
          inputMode="decimal"
          className="h-9 w-28"
          value={pct}
          disabled={!canManage}
          onChange={(e) => setPct(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-[var(--text-muted)]">On the invoice</span>
        <select
          id="finance-lines"
          className="h-9 rounded-md border bg-background px-2 text-sm"
          value={lines}
          disabled={!canManage}
          onChange={(e) => setLines(e.target.value as FinanceSettings["reimbursableLines"])}
        >
          <option value="one">One line: cost plus markup</option>
          <option value="two">Two lines: cost, then markup</option>
        </select>
      </label>
      {canManage && (
        <Button
          size="sm"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate({ reimbursableMarkupPct: n, reimbursableLines: lines })}
        >
          Save
        </Button>
      )}
    </section>
  );
}
