"use client";
/**
 * Multi-type @-mention typeahead. Self-contained: fetches from the shared
 * entity index (`useEntitySearch`), groups results by type with an icon +
 * header, and supports ↑/↓/Enter/Esc. Reused by chat, comments, and the
 * assistant composer. Insertion is the caller's job (via `onPick`).
 */
import { useEffect, useRef, useState } from "react";
import { useEntitySearch } from "./hooks";
import { ENTITY_ICON } from "@/lib/mentions/registry.client";
import {
  ENTITY_LABEL_PLURAL,
  type EntityType,
  type ResolvedEntity,
} from "@/lib/mentions/refs";

export function EntityMentionPicker({
  orgId,
  query,
  anchor,
  onPick,
  onCancel,
  types,
}: {
  orgId: string;
  query: string;
  anchor: { top: number; left: number };
  onPick: (hit: ResolvedEntity) => void;
  onCancel: () => void;
  types?: EntityType[];
}) {
  const { data, isFetching } = useEntitySearch(orgId, query, types);
  const hits = (data ?? []).slice(0, 20);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  // Clamp on read (results can shrink between renders) — avoids a setState in an
  // effect. The raw `active` reconverges on the next arrow keypress.
  const activeIdx = hits.length === 0 ? 0 : Math.min(active, hits.length - 1);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowDown") {
        setActive(() => Math.min(hits.length - 1, activeIdx + 1));
        e.preventDefault();
      } else if (e.key === "ArrowUp") {
        setActive(() => Math.max(0, activeIdx - 1));
        e.preventDefault();
      } else if (e.key === "Enter") {
        if (hits[activeIdx]) {
          onPick(hits[activeIdx]);
          e.preventDefault();
        }
      } else if (e.key === "Escape") {
        onCancel();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hits, activeIdx, onPick, onCancel]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${activeIdx}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  if (query.trim().length === 0) return null;
  if (hits.length === 0) {
    return (
      <div
        className="fixed z-50 bg-popover border rounded shadow-md text-sm min-w-[220px] px-3 py-2 text-muted-foreground"
        style={{ top: anchor.top, left: anchor.left }}
      >
        {isFetching ? "Searching…" : "No matches"}
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      className="fixed z-50 bg-popover border rounded shadow-md text-sm min-w-[260px] max-w-[min(24rem,calc(100vw-1rem))] max-h-80 overflow-y-auto py-1"
      style={{ top: anchor.top, left: anchor.left }}
    >
      {hits.map((h, i) => {
        const prev = hits[i - 1];
        const showHeader = !prev || prev.type !== h.type;
        const Icon = ENTITY_ICON[h.type];
        return (
          <div key={`${h.type}:${h.id}`}>
            {showHeader && (
              <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {ENTITY_LABEL_PLURAL[h.type]}
              </div>
            )}
            <button
              type="button"
              data-idx={i}
              onMouseEnter={() => setActive(i)}
              onClick={() => onPick(h)}
              className={
                "w-full px-3 py-1.5 flex items-center gap-2 text-left " +
                (i === activeIdx ? "bg-accent" : "hover:bg-accent")
              }
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{h.label}</span>
              {h.sublabel && (
                <span className="ml-auto pl-2 text-xs text-muted-foreground truncate max-w-[40%]">
                  {h.sublabel}
                </span>
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}
