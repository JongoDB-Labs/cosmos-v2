"use client";

import { Compass, Check } from "lucide-react";
import { PluginRegistry } from "@/lib/plugins/registry";
import { useEnabledPlugins } from "@/components/plugins/plugin-slot";
import { usePermissions } from "@/components/providers/permissions-provider";
import { availableTours } from "@/lib/tours/registry";
import { readSeenTours, markTourSeen } from "@/lib/tours/seen";
import { readProgress } from "@/lib/tours/progress";
import { useTour } from "./tour-provider";
import { cn } from "@/lib/utils";

/**
 * Every walkthrough on offer, newest first, startable at any time.
 *
 * The What's-new notice offers the newest one once. This is the way back to it,
 * and to the ones before it: somebody who joined last month should be able to
 * catch up on what changed the month before, and somebody who dismissed the
 * notice should not have lost the walkthrough with it. One left part-way is
 * offered back at the step it was left on, with "Start over" beside it.
 *
 * Renders NOTHING when nothing is on offer, which is the state of every
 * deployment that has not been given a walkthrough.
 */
export function TourLauncher({ onPick }: { onPick?: () => void }) {
  const enabled = useEnabledPlugins();
  const { permissions } = usePermissions();
  const { start } = useTour();
  const tours = availableTours(PluginRegistry.getAll(), enabled, permissions);
  if (tours.length === 0) return null;
  const seen = readSeenTours();

  return (
    <div className="flex flex-col gap-1">
      <p className="px-2 py-1 text-[0.65rem] uppercase tracking-wider text-[var(--text-muted)]">
        Walkthroughs
      </p>
      {tours.map((t) => {
        // Where this browser left off. A walkthrough left part-way is offered
        // back at that step: the "Resume" on the closing toast is gone after a
        // reload or a new session, and this menu is the way back.
        const at = readProgress(t.id);
        const resumable = at > 0 && at < t.steps.length - 1;
        return (
          <div key={t.id} className="flex items-start gap-1 rounded hover:bg-[var(--primary-tint)]">
            <button
              type="button"
              onClick={() => {
                markTourSeen(t.id);
                start(t, resumable ? at : 0);
                onPick?.();
              }}
              className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left"
            >
              <Compass className="mt-0.5 size-3.5 shrink-0 text-[var(--text-muted)]" />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  {t.name}
                  {seen.has(t.id) && (
                    <Check className="size-3 text-[var(--text-muted)]" aria-label="already seen" />
                  )}
                </span>
                <span className="block truncate text-xs text-[var(--text-muted)]">
                  {resumable ? `Resume at step ${at + 1} of ${t.steps.length}` : t.summary}
                </span>
              </span>
            </button>
            {resumable && (
              <button
                type="button"
                onClick={() => {
                  start(t, 0);
                  onPick?.();
                }}
                aria-label={`Start ${t.name} over`}
                className={cn(
                  "shrink-0 px-2 py-1.5 text-xs text-[var(--text-muted)]",
                  "hover:text-[var(--text)] hover:underline",
                )}
              >
                Start over
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
