"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

type BankRule = {
  id: string;
  name: string;
  descriptionContains: string | null;
  direction: string;
  amountMin: string | null;
  amountMax: string | null;
  category: string;
  priority: number;
  isActive: boolean;
};

const DIRECTIONS = ["any", "outflow", "inflow"] as const;

const emptyForm = {
  category: "",
  descriptionContains: "",
  direction: "any" as string,
  amountMin: "",
  amountMax: "",
  priority: "0",
};

export function BankRulesDialog({
  orgId,
  open,
  onOpenChange,
}: {
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [form, setForm] = useState(emptyForm);

  const rulesKey = useOrgQueryKey("bank", "rules");
  const rulesQ = useQuery({
    queryKey: rulesKey,
    enabled: open,
    queryFn: () =>
      jsonFetch<{ data: BankRule[] }>(`/api/v1/orgs/${orgId}/bank-rules`).then(
        (r) => r.data,
      ),
  });

  const create = useOrgMutation<unknown, Error, void>({
    mutationFn: () =>
      jsonFetch(`/api/v1/orgs/${orgId}/bank-rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: form.category.trim(),
          descriptionContains: form.descriptionContains.trim() || null,
          direction: form.direction,
          amountMin: form.amountMin ? Number(form.amountMin) : null,
          amountMax: form.amountMax ? Number(form.amountMax) : null,
          priority: Number(form.priority) || 0,
        }),
      }),
    invalidate: [["bank", "rules"]],
    onSuccess: () => setForm(emptyForm),
    onError: (e) => notifyError(e, "Couldn't save rule."),
  });

  const remove = useOrgMutation<unknown, Error, string>({
    mutationFn: (id: string) =>
      jsonFetch(`/api/v1/orgs/${orgId}/bank-rules/${id}`, { method: "DELETE" }),
    invalidate: [["bank", "rules"]],
    onError: (e) => notifyError(e, "Couldn't delete rule."),
  });

  const toggle = useOrgMutation<unknown, Error, BankRule>({
    mutationFn: (rule: BankRule) =>
      jsonFetch(`/api/v1/orgs/${orgId}/bank-rules/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !rule.isActive }),
      }),
    invalidate: [["bank", "rules"]],
    onError: (e) => notifyError(e, "Couldn't update rule."),
  });

  const rules = rulesQ.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Bank rules</DialogTitle>
          <DialogDescription>
            On import, the first matching rule pre-fills a transaction&apos;s
            category. You still review and post each one.
          </DialogDescription>
        </DialogHeader>

        {/* Create form */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (form.category.trim()) create.mutate();
          }}
          className="grid grid-cols-2 gap-3 rounded-lg border p-3 sm:grid-cols-3"
        >
          <div className="col-span-2 flex flex-col gap-1 sm:col-span-1">
            <Label className="text-xs">Category *</Label>
            <Input
              className="h-8"
              placeholder="e.g. Software"
              value={form.category}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
            />
          </div>
          <div className="col-span-2 flex flex-col gap-1">
            <Label className="text-xs">Description contains</Label>
            <Input
              className="h-8"
              placeholder="e.g. AWS"
              value={form.descriptionContains}
              onChange={(e) =>
                setForm((f) => ({ ...f, descriptionContains: e.target.value }))
              }
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">Direction</Label>
            <div className="flex rounded-md border p-0.5">
              {DIRECTIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, direction: d }))}
                  className={`flex-1 rounded px-2 py-1 text-xs capitalize transition-colors ${
                    form.direction === d
                      ? "bg-muted font-medium"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">Min amount</Label>
            <Input
              className="h-8"
              type="number"
              min="0"
              step="0.01"
              placeholder="—"
              value={form.amountMin}
              onChange={(e) => setForm((f) => ({ ...f, amountMin: e.target.value }))}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs">Max amount</Label>
            <Input
              className="h-8"
              type="number"
              min="0"
              step="0.01"
              placeholder="—"
              value={form.amountMax}
              onChange={(e) => setForm((f) => ({ ...f, amountMax: e.target.value }))}
            />
          </div>
          <div className="col-span-2 flex items-end justify-end sm:col-span-3">
            <Button
              type="submit"
              size="sm"
              disabled={form.category.trim() === "" || create.isPending}
            >
              Add rule
            </Button>
          </div>
        </form>

        {/* Existing rules */}
        <div className="flex max-h-72 flex-col gap-1 overflow-auto">
          {rulesQ.isLoading ? (
            <Skeleton className="h-24 rounded-lg" />
          ) : rules.length === 0 ? (
            <EmptyState title="No rules yet — add one above." />
          ) : (
            rules.map((rule) => (
              <div
                key={rule.id}
                className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm ${
                  rule.isActive ? "" : "opacity-50"
                }`}
              >
                <div className="min-w-0">
                  <div className="font-medium">{rule.category}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {[
                      rule.descriptionContains
                        ? `“${rule.descriptionContains}”`
                        : null,
                      rule.direction !== "any" ? rule.direction : null,
                      rule.amountMin ? `≥ ${rule.amountMin}` : null,
                      rule.amountMax ? `≤ ${rule.amountMax}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "matches everything"}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={toggle.isPending && toggle.variables?.id === rule.id}
                    onClick={() => toggle.mutate(rule)}
                  >
                    {rule.isActive ? "Pause" : "Activate"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={remove.isPending && remove.variables === rule.id}
                    onClick={() => remove.mutate(rule.id)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
