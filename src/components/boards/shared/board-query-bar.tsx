"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { QueryBuilder } from "@/components/work-items/cql/query-builder";
import type { BoardQuery } from "./use-board-query";

/**
 * The board's filter bar with the query language on: the same chips and
 * editor as Issues (query design §12.1), with a line naming the board's own
 * scope, which the query narrows and "Clear" returns to. `children` holds
 * presentation controls that aren't filters (swimlanes).
 *
 * ONE row of the builder carries everything, not a row of its own under it:
 * the scope line, `children` and `actions` go to the builder as `trailing`
 * (see QueryBuilder), which puts them beside the search box in Filters mode
 * and beside "Add filter" in CQL mode. They used to be this band's bottom row,
 * the row that pushed a sprint board's columns furthest down.
 *
 * This owns its own band -- `border-b px-4 py-2`, matching `FilterBar`'s root
 * and the toolbars beneath it -- because the alternative is every board
 * wrapping it, and six of them did, which banded the filter surface twice.
 * Ownership also makes the no-schema case render nothing instead of an empty
 * bordered strip: see `chrome-bands.arch.test.ts`.
 */
export function BoardQueryBar({
  orgId,
  q,
  children,
  actions,
}: {
  orgId: string;
  q: BoardQuery;
  children?: ReactNode;
  /**
   * The board's own actions, at the end of the builder's last row. Same slot
   * and same reason as `FilterBar`'s: these used to be a second
   * `<BoardToolbar>` band stacked underneath, holding two controls with an
   * empty middle. See ffe324aa.
   *
   * These must NOT be gated on `q.schema`. This band returns null until the
   * schema arrives (fetched, `retry: false`), and an earlier draft let the
   * actions go with it -- so on a CQL-enabled org "New work item", "Group by" and
   * the density toggles vanished until a request that may simply have FAILED
   * came back. `table-view.grouping.test.tsx` caught it. None of these controls
   * needs a schema; creating an issue is not a query.
   */
  actions?: ReactNode;
}) {
  // No schema yet: show the board's own controls alone rather than nothing,
  // so they survive a slow or failed /cql/schema. Swimlanes included: grouping
  // the cards needs a schema no more than "New work item" does, and it used to
  // vanish with the builder. With nothing to put in it, still render nothing
  // -- an empty bordered strip where the filter bar belongs is the failure
  // `chrome-bands.arch.test.ts` was written about.
  if (!q.schema) {
    return children || actions ? (
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-2">
        {children}
        {actions}
      </div>
    ) : null;
  }
  // A `problem` gets priority over the scope, and keeps role="alert". The
  // scope itself is a ScopeLine (below).
  const scope = q.problem ? (
    <p role="alert" className="text-xs text-[var(--status-blocked-text)]">
      This board shows nothing: {q.problem}.
    </p>
  ) : q.baselineCql ? (
    <ScopeLine cql={q.baselineCql} />
  ) : null;
  return (
    <div className="relative border-b border-[var(--border)] px-4 py-2">
      {/* `variant="inline"`: this band already draws the border and padding, so
          the builder's own card would be framing inside framing. Measured on
          prod, that card cost 26 of the band's 147 vertical pixels.
          The builder's own Clear empties the query: back to the board's scope. */}
      <QueryBuilder
        orgId={orgId}
        schema={q.schema}
        cql={q.cql}
        onCqlChange={q.setCql}
        mode={q.mode}
        onModeChange={q.setMode}
        serverDiagnostics={q.diagnostics}
        variant="inline"
        trailing={
          <>
            {scope}
            {children}
            {actions}
          </>
        }
      />
      {/* Out of the flow, on the band's bottom edge. In flow it was a word that
          appeared and vanished with every query, and in a full row that is
          enough to push the last control onto a line of its own and back --
          moving the whole board down and up each time. Still the live region
          a screen reader hears. Above the board's sticky header row (Table's
          thead is z-10), which otherwise hid its lower half. */}
      <span
        aria-live="polite"
        className="pointer-events-none absolute bottom-0 right-4 z-20 translate-y-1/2 text-xs leading-none"
      >
        {q.pending ? (
          <span className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[var(--text-muted)]">
            Filtering…
          </span>
        ) : (
          ""
        )}
      </span>
    </div>
  );
}

/**
 * The board's scope, as main showed it: at its own width, moving to the next
 * line when this one is full, and cut off with an ellipsis only when it is
 * longer than a whole line (a sentence-long saved query must not claim two or
 * three rows above every board). When it is cut off, More shows the rest in
 * place, by keyboard and touch too; `title` alone reached only a mouse.
 */
function ScopeLine({ cql }: { cql: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [cut, setCut] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setCut(el.scrollWidth > el.clientWidth + 1);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, [cql, open]);
  return (
    <div className="flex min-w-0 max-w-full items-baseline gap-1">
      <p ref={ref} className={cn("min-w-0 text-xs text-[var(--text-muted)]", !open && "truncate")} title={cql}>
        This board shows{" "}
        <code className="rounded border border-[var(--border)] px-1 [overflow-wrap:anywhere]">{cql}</code>
      </p>
      {(cut || open) && (
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "Less of this board's scope" : "More of this board's scope"}
          onClick={() => setOpen((o) => !o)}
          className="shrink-0 text-xs text-[var(--text-muted)] underline underline-offset-2 hover:text-[var(--text)]"
        >
          {open ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}
