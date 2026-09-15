"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SectionCard } from "@/components/ui/section-card";
import { Textarea } from "@/components/ui/textarea";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { notifyError } from "@/lib/errors/notify";
import { cn } from "@/lib/utils";

/**
 * Bring a trial balance from a bookkeeping system into the ledger.
 *
 * PREVIEW FIRST, always. The API returns three numbers before anything posts —
 * the adjusting entry, the balancing figure headed for Opening Balance Equity,
 * and the submitted file's own imbalance — and this screen exists mostly to put
 * all three in front of a person while they can still change their mind. An
 * import that posts on the first click is one nobody trusts twice.
 *
 * The preview and the commit send an IDENTICAL body but for `commit`, so the
 * numbers reviewed are the numbers that post.
 */

interface PlanLine {
  code: string;
  name: string;
  current: string;
  target: string;
  delta: string;
}

interface Plan {
  unchanged: boolean;
  residual: string;
  submittedImbalance: string;
  lines: PlanLine[];
}

interface ImportResult {
  posted: boolean;
  preview?: boolean;
  asOf: string;
  skipped: { line: number; reason: string }[];
  plan: Plan;
  entryNumber?: string;
  reason?: string;
}

const money = (v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
};
const isZero = (v: string) => Math.abs(Number(v)) < 0.005;

export function TrialBalanceImport({ orgId }: { orgId: string }) {
  const today = new Date().toISOString().slice(0, 10);
  const [asOf, setAsOf] = useState(today);
  const [csv, setCsv] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const send = async (commit: boolean) => {
    setBusy(true);
    try {
      const res = await jsonFetch<ImportResult>(
        `/api/v1/orgs/${orgId}/accounting/gl-import`,
        {
          method: "POST",
          body: JSON.stringify({ asOf, csv, memo: memo || undefined, commit }),
        },
      );
      setResult(res);
      // A commit invalidates every figure on screen elsewhere; clearing the
      // paste box is what stops the same file being posted twice by reflex.
      if (commit && res.posted) setCsv("");
    } catch (err) {
      notifyError(err, commit ? "Couldn't post the import" : "Couldn't preview the import");
    } finally {
      setBusy(false);
    }
  };

  const posted = result?.posted === true;

  return (
    <div className="space-y-6">
      <SectionCard
        icon={Upload}
        title="Trial balance"
        description="Paste a CSV export — account code, debit, credit. Nothing posts until you have seen what it would do."
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              As of
              <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            </label>
            <label className="space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              Memo (optional)
              <Input
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                placeholder="e.g. July close from QuickBooks"
              />
            </label>
          </div>
          <label className="block space-y-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
            CSV
            <Textarea
              rows={8}
              className="font-mono text-xs"
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              placeholder={"1000,125000.00,\n4000,,480000.00\n6100,310000.00,"}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => send(false)} disabled={busy || csv.trim() === ""}>
              Preview
            </Button>
            <Button
              variant="secondary"
              onClick={() => send(true)}
              // Commit is deliberately unreachable until a preview has been
              // seen: the whole design of the endpoint is that the numbers are
              // reviewed first, and a UI that lets you skip that throws it away.
              disabled={busy || result === null || result.preview !== true || result.plan.unchanged}
            >
              Post to the ledger
            </Button>
          </div>
        </div>
      </SectionCard>

      {result !== null && (
        <SectionCard
          icon={posted ? CheckCircle2 : AlertTriangle}
          title={posted ? `Posted — entry ${result.entryNumber ?? ""}`.trim() : "Preview"}
          description={
            posted
              ? "These figures are now in the ledger."
              : "What would post. Nothing has changed yet."
          }
        >
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Figure
                label="To Opening Balance Equity"
                value={money(result.plan.residual)}
                tone={isZero(result.plan.residual) ? "ok" : "warn"}
                note={
                  isZero(result.plan.residual)
                    ? "Nothing left over — the accounts you sent reconcile."
                    : "The balancing figure. A full trial balance leaves this at zero; a partial one puts the difference somewhere named rather than distorting a real account."
                }
              />
              <Figure
                label="Imbalance in the file"
                value={money(result.plan.submittedImbalance)}
                tone={isZero(result.plan.submittedImbalance) ? "ok" : "warn"}
                note={
                  isZero(result.plan.submittedImbalance)
                    ? "The file's own debits and credits agree."
                    : "The file you sent does not balance. Reported, not refused — but worth understanding before posting."
                }
              />
            </div>

            {result.skipped.length > 0 && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                <p className="font-medium">{result.skipped.length} row(s) skipped</p>
                <ul className="mt-1 space-y-0.5 text-[var(--text-muted)]">
                  {result.skipped.slice(0, 8).map((sk) => (
                    <li key={sk.line}>
                      Line {sk.line}: {sk.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {result.plan.unchanged ? (
              <p className="text-sm text-[var(--text-muted)]">
                Every account already matches these figures. There is nothing to post.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
                    <tr>
                      <th className="py-1 pr-3">Account</th>
                      <th className="py-1 pr-3 text-right">In the ledger</th>
                      <th className="py-1 pr-3 text-right">In the file</th>
                      <th className="py-1 text-right">Adjustment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.plan.lines.map((l) => (
                      <tr key={l.code} className="border-t border-[var(--border)]">
                        <td className="py-1 pr-3">
                          <span className="tabular-nums text-[var(--text-muted)]">{l.code}</span> {l.name}
                        </td>
                        <td className="py-1 pr-3 text-right tabular-nums">{money(l.current)}</td>
                        <td className="py-1 pr-3 text-right tabular-nums">{money(l.target)}</td>
                        <td
                          className={cn(
                            "py-1 text-right tabular-nums",
                            isZero(l.delta) ? "text-[var(--text-muted)]" : "font-medium",
                          )}
                        >
                          {money(l.delta)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </SectionCard>
      )}
    </div>
  );
}

function Figure({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: string;
  tone: "ok" | "warn";
  note: string;
}) {
  return (
    <div
      className={cn(
        "rounded-md border p-3",
        tone === "ok" ? "border-[var(--border)]" : "border-amber-500/40 bg-amber-500/5",
      )}
    >
      <p className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{label}</p>
      <p className="mt-0.5 text-lg font-medium tabular-nums">{value}</p>
      <p className="mt-1 text-xs text-[var(--text-muted)]">{note}</p>
    </div>
  );
}
