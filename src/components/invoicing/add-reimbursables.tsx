"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { Button } from "@/components/ui/button";
import { pctLabel } from "@/lib/finance/rebill";
import type { MarkupSource } from "@/lib/finance/markup";

const fmt = (v: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(v);

type Item = {
  source: "bill" | "expense";
  id: string;
  label: string;
  date: string | null;
  cost: number;
  markup: { pct: number; source: MarkupSource };
  markupAmount: number;
  total: number;
};
type Payload = { items: Item[]; lines: "one" | "two" };

const key = (i: Pick<Item, "source" | "id">) => `${i.source}:${i.id}`;

/**
 * "Add reimbursables" on a draft invoice with a project: the project's
 * unbilled bills and reimbursable expenses, each at cost plus its markup, all
 * picked to start with. Adding them puts their lines on the invoice and marks
 * each cost as billed by it. Renders nothing when there is nothing to add, or
 * for someone who can't read finance.
 */
export function AddReimbursables({ orgId, invoiceId }: { orgId: string; invoiceId: string }) {
  const url = `/api/v1/orgs/${orgId}/invoices/${invoiceId}/reimbursables`;
  const q = useQuery({
    queryKey: useOrgQueryKey("invoices", invoiceId, "reimbursables"),
    queryFn: () => jsonFetch<Payload>(url),
  });
  // Unpicked, not picked: a cost that appears after the list loaded starts picked too.
  const [unpicked, setUnpicked] = useState<Set<string>>(new Set());

  const add = useOrgMutation<unknown, Error, Item[]>({
    mutationFn: (items) =>
      jsonFetch(url, {
        method: "POST",
        body: JSON.stringify({
          billIds: items.filter((i) => i.source === "bill").map((i) => i.id),
          expenseIds: items.filter((i) => i.source === "expense").map((i) => i.id),
        }),
      }),
    invalidate: [["invoices"], ["bills"]],
    onSuccess: () => setUnpicked(new Set()),
    onError: (e) => notifyError(e, "Couldn't add the reimbursables."),
  });

  const items = q.data?.items ?? [];
  if (items.length === 0) return null;
  const picked = items.filter((i) => !unpicked.has(key(i)));
  const total = picked.reduce((s, i) => s + Math.round(i.total * 100), 0) / 100;

  return (
    <section aria-label="Reimbursable costs" className="rounded-md border text-sm">
      <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
        <div>
          <div className="font-medium">Unbilled reimbursable costs</div>
          <div className="text-xs text-muted-foreground">
            Billed at cost plus markup, {q.data?.lines === "two" ? "as two lines each" : "one line each"}.
          </div>
        </div>
        <Button size="sm" disabled={picked.length === 0 || add.isPending} onClick={() => add.mutate(picked)}>
          {`Add ${picked.length} to invoice`}
        </Button>
      </div>
      <ul>
        {items.map((i) => {
          const k = key(i);
          return (
            <li key={k} className="flex items-center gap-3 border-b px-3 py-1.5 last:border-0">
              <input
                type="checkbox"
                aria-label={`Add ${i.label}`}
                checked={!unpicked.has(k)}
                onChange={(e) =>
                  setUnpicked((s) => {
                    const n = new Set(s);
                    if (e.target.checked) n.delete(k);
                    else n.add(k);
                    return n;
                  })
                }
              />
              <span className="min-w-0 flex-1 truncate">{i.label}</span>
              <span className="tabular-nums text-muted-foreground">
                {fmt(i.cost)} + {pctLabel(i.markup.pct)}
              </span>
              <span className="w-24 text-right font-medium tabular-nums">{fmt(i.total)}</span>
            </li>
          );
        })}
      </ul>
      <div className="flex justify-end gap-2 border-t px-3 py-1.5 text-xs text-muted-foreground">
        Picked: <span className="font-medium tabular-nums text-foreground" data-testid="reimbursables-picked-total">{fmt(total)}</span>
      </div>
    </section>
  );
}
