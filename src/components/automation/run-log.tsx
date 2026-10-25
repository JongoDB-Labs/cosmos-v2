"use client";

import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { LoadError } from "@/components/ui/load-error";
import { LocalTimestamp } from "@/components/ui/local-timestamp";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { RUNS_SHOWN, useAutomationRuns, type AutomationRule, type AutomationRunRow, type RunStatus } from "./api";

const STATUS: Record<RunStatus, { label: string; variant: BadgeVariant; hint: string }> = {
  SUCCESS: { label: "Done", variant: "done", hint: "Every action ran." },
  PARTIAL: { label: "Partly done", variant: "review", hint: "Some actions failed." },
  FAILED: { label: "Failed", variant: "critical", hint: "No action ran." },
  NO_MATCH: { label: "No match", variant: "neutral", hint: "The trigger fired, but the item didn't match." },
  SKIPPED_SELF: { label: "Its own change", variant: "neutral", hint: "A rule never fires on its own changes." },
  LOOP: { label: "Loop stopped", variant: "blocked", hint: "Automations kept firing each other." },
  THROTTLED: { label: "Held back", variant: "blocked", hint: "Too many runs at once." },
};

/** What a rule did, latest first: one row per run, with each failed action's reason. */
export function RunLog({ orgId, rule, onOpenChange }: { orgId: string; rule: AutomationRule | null; onOpenChange: (open: boolean) => void }) {
  const runs = useAutomationRuns(orgId, rule?.id ?? null);
  return (
    <Sheet open={rule !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Runs: {rule?.name}</SheetTitle>
          <SheetDescription>The latest {RUNS_SHOWN}. Every run except a no-match is also in the audit log.</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          {runs.isError ? (
            <LoadError title="Couldn't load the runs" onRetry={() => void runs.refetch()} />
          ) : !runs.data ? (
            <Skeleton className="h-40 w-full" />
          ) : runs.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">It hasn&apos;t run yet.</p>
          ) : (
            <ol className="divide-y text-sm" aria-label="Runs">
              {runs.data.map((r) => (
                <RunRow key={r.id} run={r} />
              ))}
            </ol>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function RunRow({ run }: { run: AutomationRunRow }) {
  const s = STATUS[run.status];
  const failed = run.actions.filter((a): a is Extract<AutomationRunRow["actions"][number], { ok: boolean }> => "ok" in a && !a.ok);
  const notes = run.actions.filter((a): a is { note: string } => "note" in a);
  const ran = run.actions.filter((a) => "ok" in a && a.ok && !a.noop).length;
  return (
    <li className="grid gap-1 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span title={s.hint}>
          <Badge variant={s.variant}>{s.label}</Badge>
        </span>
        <span className="text-muted-foreground">
          <LocalTimestamp value={run.createdAt} />
        </span>
        {run.itemsMatched > 0 && (
          <span className="text-xs text-muted-foreground">
            {run.itemsMatched} {run.itemsMatched === 1 ? "item" : "items"}, {ran} {ran === 1 ? "change" : "changes"}
          </span>
        )}
        <span className="text-xs text-muted-foreground">rev {run.ruleRevision}</span>
      </div>
      {[...notes.map((n) => n.note), ...failed.map((f) => `${f.kind}: ${f.error ?? "failed"}`)].map((text, i) => (
        <p key={i} className="text-xs text-muted-foreground">
          {text}
        </p>
      ))}
    </li>
  );
}
