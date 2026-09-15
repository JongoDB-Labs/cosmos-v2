"use client";

import { Compass, Check } from "lucide-react";
import { PluginRegistry } from "@/lib/plugins/registry";
import { useEnabledPlugins } from "@/components/plugins/plugin-slot";
import { usePermissions } from "@/components/providers/permissions-provider";
import { availableTours } from "@/lib/tours/registry";
import { readSeenTours, markTourSeen } from "@/lib/tours/seen";
import { useTour } from "./tour-provider";
import { cn } from "@/lib/utils";

/**
 * Every walkthrough on offer, newest first, startable at any time.
 *
 * The What's-new notice offers the newest one once. This is the way back to it,
 * and to the ones before it: somebody who joined last month should be able to
 * catch up on what changed the month before, and somebody who dismissed the
 * notice should not have lost the walkthrough with it.
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
      {tours.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => {
            markTourSeen(t.id);
            // Always from the top: picking a walkthrough by name is a decision
            // to watch it, not to resume something half-finished.
            start(t, 0);
            onPick?.();
          }}
          className={cn(
            "flex w-full items-start gap-2 rounded px-2 py-1.5 text-left",
            "hover:bg-[var(--surface-hover)]",
          )}
        >
          <Compass className="mt-0.5 size-3.5 shrink-0 text-[var(--text-muted)]" />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              {t.name}
              {seen.has(t.id) && (
                <Check className="size-3 text-[var(--text-muted)]" aria-label="already seen" />
              )}
            </span>
            <span className="block truncate text-xs text-[var(--text-muted)]">{t.summary}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
