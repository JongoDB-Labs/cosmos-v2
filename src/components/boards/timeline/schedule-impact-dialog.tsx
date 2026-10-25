"use client";

import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { ImpactSection, ImpactTone } from "@/lib/work-items/schedule-impact";

// Text tokens, not fills: these are words, and must read in both themes.
const toneClass: Record<ImpactTone, string> = {
  neutral: "text-foreground",
  positive: "text-[var(--status-done-text)]",
  warn: "text-[var(--status-blocked-text)]",
  critical: "text-[var(--status-critical-text)]",
};
// Said as well as shown: colour alone is not a signal (WCAG 1.4.1).
const toneWord: Record<ImpactTone, string | null> = {
  neutral: null,
  positive: "Better",
  warn: "Check",
  critical: "Problem",
};

/**
 * The confirm step before a reschedule is saved: what it would move, who ends
 * up with more on at once, and whatever enabled plugins add (fees, rates,
 * hours). Generic, so a plugin's own schedule page can mount it with sections
 * from its own preview and the step reads the same everywhere.
 *
 * Nothing is saved until Save. Cancel (or Escape) leaves everything as it was.
 */
export function ScheduleImpactDialog({
  open,
  sections,
  pending = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  sections: ImpactSection[];
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onCancel();
      }}
    >
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>Save this schedule change?</DialogTitle>
          <DialogDescription>Here is what else it changes. Nothing is saved until you choose Save.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {sections.map((s) => (
            <section key={s.key} aria-labelledby={`impact-${s.key}`} className="space-y-1.5">
              <h3 id={`impact-${s.key}`} className="text-sm font-semibold">
                {s.title}
              </h3>
              {s.rows.length > 0 && (
                <ul className="divide-y divide-border rounded-md border border-border text-sm">
                  {s.rows.map((r) => (
                    <li key={r.key} data-row={r.key} className="space-y-0.5 px-2.5 py-1.5">
                      <div className="font-medium">{r.label}</div>
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      {(r.before || r.after) && (
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          {r.before && <span>{r.before}</span>}
                          {r.before && r.after && (
                            <>
                              <ArrowRight className="size-3" aria-hidden />
                              <span className="sr-only">to</span>
                            </>
                          )}
                          {r.after && <span className={cn(toneClass[r.tone], "font-medium")}>{r.after}</span>}
                        </span>
                      )}
                      {r.delta && <span className={cn("text-xs", toneClass[r.tone])}>{r.delta}</span>}
                      {toneWord[r.tone] && <span className="sr-only">{`(${toneWord[r.tone]})`}</span>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {s.prompt && (
                <p className="text-sm text-muted-foreground">
                  {s.prompt.message}
                  {s.prompt.action && (
                    <>
                      {" "}
                      <a href={s.prompt.action.href} className="font-medium text-primary underline underline-offset-2">
                        {s.prompt.action.label}
                      </a>
                    </>
                  )}
                </p>
              )}
            </section>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
