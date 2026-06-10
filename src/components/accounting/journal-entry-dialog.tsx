"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { notifyError } from "@/lib/errors/notify";

interface AccountOption {
  id: string;
  code: string;
  name: string;
}

type Line = {
  key: string;
  accountId: string;
  direction: "DEBIT" | "CREDIT";
  amount: string;
};

const fmt = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
const round2 = (n: number) => Math.round(n * 100) / 100;

let lineSeq = 0;
const newLine = (direction: "DEBIT" | "CREDIT"): Line => ({
  key: `l${lineSeq++}`,
  accountId: "",
  direction,
  amount: "",
});

/**
 * Create a MANUAL journal entry. The server (postEntry/assertBalanced) is the
 * source of truth for balance, but we mirror the check live here so Save only
 * enables on a balanced, fully-specified entry — no round-trip to discover it's
 * off by a cent.
 */
export function JournalEntryDialog({
  orgId,
  accounts,
  open,
  onOpenChange,
}: {
  orgId: string;
  accounts: AccountOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<Line[]>(() => [newLine("DEBIT"), newLine("CREDIT")]);

  const reset = () => {
    setMemo("");
    setLines([newLine("DEBIT"), newLine("CREDIT")]);
  };

  const create = useOrgMutation<unknown, Error, void>({
    mutationFn: () =>
      jsonFetch(`/api/v1/orgs/${orgId}/accounting/journal-entries`, {
        method: "POST",
        body: JSON.stringify({
          date: new Date(`${date}T00:00:00.000Z`).toISOString(),
          memo: memo.trim() || undefined,
          lines: lines.map((l) => ({
            accountId: l.accountId,
            direction: l.direction,
            amount: l.amount, // string → Decimal-safe on the server
          })),
        }),
      }),
    invalidate: [["accounting"]],
    onSuccess: () => {
      reset();
      onOpenChange(false);
    },
    onError: (e) => notifyError(e, "Couldn't post the journal entry."),
  });

  const debits = round2(
    lines
      .filter((l) => l.direction === "DEBIT")
      .reduce((s, l) => s + (Number(l.amount) || 0), 0),
  );
  const credits = round2(
    lines
      .filter((l) => l.direction === "CREDIT")
      .reduce((s, l) => s + (Number(l.amount) || 0), 0),
  );
  const balanced = debits > 0 && debits === credits;
  const allSpecified = lines.every(
    (l) => l.accountId !== "" && (Number(l.amount) || 0) > 0,
  );
  const valid = lines.length >= 2 && allSpecified && balanced;

  function patchLine(key: string, patch: Partial<Line>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !create.isPending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New journal entry</DialogTitle>
          <DialogDescription>
            Post a manual double-entry. Debits must equal credits.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="space-y-1.5">
              <Label htmlFor="je-date">Date</Label>
              <Input
                id="je-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full sm:w-44"
              />
            </div>
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="je-memo">Memo</Label>
              <Input
                id="je-memo"
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                placeholder="What is this entry for?"
                maxLength={500}
              />
            </div>
          </div>

          <div className="space-y-2">
            {lines.map((l) => (
              <div key={l.key} className="flex items-center gap-2">
                <Select
                  value={l.accountId}
                  onValueChange={(v) => patchLine(l.key, { accountId: v ?? "" })}
                >
                  <SelectTrigger size="sm" aria-label="Account" className="h-8 flex-1">
                    <SelectValue placeholder="Account…" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.code} · {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={l.direction}
                  onValueChange={(v) =>
                    patchLine(l.key, { direction: (v as "DEBIT" | "CREDIT") ?? "DEBIT" })
                  }
                >
                  <SelectTrigger size="sm" aria-label="Direction" className="h-8 w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="DEBIT">Debit</SelectItem>
                    <SelectItem value="CREDIT">Credit</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  value={l.amount}
                  onChange={(e) => patchLine(l.key, { amount: e.target.value })}
                  placeholder="0.00"
                  className="h-8 w-28 text-right tabular-nums"
                />
                <button
                  type="button"
                  onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                  disabled={lines.length <= 2}
                  aria-label="Remove line"
                  className="shrink-0 text-muted-foreground hover:text-destructive disabled:opacity-30"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5"
              onClick={() => setLines((ls) => [...ls, newLine("DEBIT")])}
            >
              <Plus className="h-3.5 w-3.5" /> Add line
            </Button>
          </div>

          {/* Live balance indicator */}
          <div className="flex items-center justify-end gap-4 border-t pt-2 text-sm tabular-nums">
            <span className="text-muted-foreground">
              Debits <span className="text-foreground">{fmt(debits)}</span>
            </span>
            <span className="text-muted-foreground">
              Credits <span className="text-foreground">{fmt(credits)}</span>
            </span>
            <span
              className={
                balanced
                  ? "font-medium text-[var(--status-done,green)]"
                  : "font-medium text-destructive"
              }
            >
              {balanced ? "Balanced" : `Off by ${fmt(Math.abs(debits - credits))}`}
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          <Button onClick={() => create.mutate()} disabled={!valid || create.isPending}>
            {create.isPending ? "Posting…" : "Post entry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
