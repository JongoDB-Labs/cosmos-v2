"use client";

import { useState } from "react";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { Input } from "@/components/ui/input";
import { MAX_MARKUP_PCT, type MarkupSource } from "@/lib/finance/markup";

const SOURCE: Record<MarkupSource, string> = { bill: "", project: "project", org: "org default" };

const pctLabel = (n: number) => `${Number(n.toFixed(4))}%`;

/** "" clears the bill's own markup (inherit); otherwise a percent in range, or undefined when invalid. */
export function parseMarkupInput(raw: string): number | null | undefined {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= MAX_MARKUP_PCT ? n : undefined;
}

/**
 * A bill's markup in the bills table: the percent that applies and, when the
 * bill doesn't set its own, where it comes from. With finance-manage the
 * figure is a button that edits the bill's own percent in place; clearing it
 * goes back to inheriting.
 */
export function MarkupCell({
  orgId,
  bill,
  canManage,
}: {
  orgId: string;
  bill: {
    id: string;
    reference: string;
    markupPct: number | null;
    markup: { pct: number; source: MarkupSource } | null;
  };
  canManage: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const save = useOrgMutation({
    mutationFn: (markupPct: number | null) =>
      jsonFetch(`/api/v1/orgs/${orgId}/bills/${bill.id}`, {
        method: "PATCH",
        body: JSON.stringify({ markupPct }),
      }),
    invalidate: [["bills"]],
    onSettled: () => setEditing(false),
  });

  // No project, no client to re-bill: markup doesn't apply.
  if (!bill.markup) return <span className="text-[var(--text-muted)]">—</span>;

  if (editing) {
    const commit = () => {
      const v = parseMarkupInput(draft);
      if (v === undefined || v === bill.markupPct) return setEditing(false);
      save.mutate(v);
    };
    return (
      <Input
        autoFocus
        type="number"
        min={0}
        max={MAX_MARKUP_PCT}
        step="0.01"
        aria-label={`Markup for ${bill.reference}`}
        placeholder="Inherit"
        className="h-8 w-24 text-right"
        value={draft}
        disabled={save.isPending}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }

  const from = SOURCE[bill.markup.source];
  const label = (
    <>
      <span className="tabular-nums">{pctLabel(bill.markup.pct)}</span>
      {from && <span className="ml-1 text-xs text-[var(--text-muted)]">({from})</span>}
    </>
  );
  if (!canManage) return label;
  return (
    <button
      type="button"
      className="rounded px-1 hover:bg-[var(--surface)]"
      aria-label={`Change markup for ${bill.reference}`}
      onClick={() => {
        setDraft(bill.markupPct === null ? "" : String(bill.markupPct));
        setEditing(true);
      }}
    >
      {label}
    </button>
  );
}
