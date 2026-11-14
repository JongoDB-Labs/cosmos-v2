"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { KIND_ICON } from "./event-chip";
import {
  DEFAULT_TOGGLES,
  KIND_LABEL,
  OVERLAY_STYLES,
  parseToggles,
  type OverlayKey,
  type OverlayKind,
  type OverlayToggles,
} from "@/lib/program-calendar/overlays";

/**
 * The viewer's overlay toggles, remembered in this browser.
 *
 * localStorage rather than the server, because that is where every other
 * per-viewer display choice in Cosmos lives: the sidebar's open groups, the
 * Gantt's column width, the assistant panel. `UserPreferences` holds account
 * settings a person edits on the Preferences page; a calendar's layers are a
 * view state, like a collapsed group, and putting them there would mean a
 * schema change and a write per click for something that is fine to differ
 * between a laptop and a phone.
 *
 * Read after mount, never during render: the server has no storage, so reading
 * it in render would hydrate a different tree than the server sent. Until then
 * the defaults show, which is also what a first visit sees.
 */
export function useOverlayToggles(storageKey: string | undefined) {
  const [toggles, setToggles] = useState<OverlayToggles>(DEFAULT_TOGGLES);

  useEffect(() => {
    if (!storageKey) return;
    try {
      // The documented localStorage-rehydration exception (see use-nav-groups.ts).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setToggles(parseToggles(window.localStorage.getItem(storageKey)));
    } catch {
      /* storage blocked: keep the defaults */
    }
  }, [storageKey]);

  const toggle = useCallback(
    (key: OverlayKey) => {
      setToggles((prev) => {
        const next = { ...prev, [key]: !prev[key] };
        if (storageKey) {
          try {
            window.localStorage.setItem(storageKey, JSON.stringify(next));
          } catch {
            /* quota or private mode: the choice still applies to this visit */
          }
        }
        return next;
      });
    },
    [storageKey],
  );

  return { toggles, toggle };
}

export interface OverlayToggleSpec {
  key: OverlayKey;
  label: string;
  /** The tint its chips carry, for the swatch on the button. */
  swatchRgb: string;
  /** Items it holds in the visible window, or null while off or loading. */
  count: number | null;
  loading?: boolean;
  /** Why it has nothing to show yet ("not connected"), said on the button
   *  itself, so the reason is there before anyone presses it. */
  hint?: string;
}

/**
 * One toggle per overlay, each independent: any combination may be on.
 *
 * Plain buttons with `aria-pressed`, the same pattern as the Day/Week/Month
 * switch beside them, so Tab reaches each one and Space or Enter flips it with
 * no extra key handling. The count is the overlay's size in the window on
 * screen, so a toggle that is on but quiet reads "0" rather than looking
 * broken.
 */
export function OverlayToggles({
  specs,
  toggles,
  onToggle,
}: {
  specs: OverlayToggleSpec[];
  toggles: OverlayToggles;
  onToggle: (key: OverlayKey) => void;
}) {
  return (
    <div role="group" aria-label="Overlays" className="flex items-center gap-0.5 rounded-md border p-0.5">
      {specs.map((s) => {
        const on = toggles[s.key];
        return (
          <button
            key={s.key}
            type="button"
            aria-pressed={on}
            aria-busy={s.loading || undefined}
            onClick={() => onToggle(s.key)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              on ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60",
            )}
          >
            <span
              aria-hidden
              className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-sm border", on ? "border-transparent" : "border-current")}
              style={on ? { backgroundColor: `rgb(${s.swatchRgb})` } : undefined}
            />
            {s.label}
            {s.hint ? <span className="font-normal text-muted-foreground">({s.hint})</span> : null}
            {on && s.count !== null ? (
              <span className="tabular-nums text-muted-foreground">{s.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * What each mark means, for the overlays that are on, plus anything the viewer
 * needs to know about what is NOT shown: an overlay that failed to load, or
 * one that was cut off. Said in words on the page, never left as an empty grid.
 */
export function OverlayLegend({ kinds, notes }: { kinds: OverlayKind[]; notes: ReactNode[] }) {
  if (kinds.length === 0 && notes.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-1.5 text-xs">
      {kinds.length ? (
        <ul aria-label="Legend" className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {kinds.map((k) => {
            const Icon = KIND_ICON[k];
            return (
              <li key={k} className="flex items-center gap-1 text-muted-foreground">
                <span
                  aria-hidden
                  className="pc-chip inline-flex h-4 w-4 items-center justify-center rounded-sm"
                  style={{
                    backgroundColor: `rgb(${OVERLAY_STYLES[k].tintRgb} / ${OVERLAY_STYLES[k].tintAlpha})`,
                    ["--chip-ink" as string]: OVERLAY_STYLES[k].textColor,
                    ["--chip-tint" as string]: OVERLAY_STYLES[k].tintRgb,
                  }}
                >
                  <Icon className="h-3 w-3" />
                </span>
                {KIND_LABEL[k]}
              </li>
            );
          })}
        </ul>
      ) : null}
      {notes.length ? (
        <div role="status" className="flex flex-col gap-0.5 text-foreground">
          {notes.map((n, i) => (
            <p key={i}>{n}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
