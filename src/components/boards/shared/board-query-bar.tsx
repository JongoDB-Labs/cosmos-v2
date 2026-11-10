"use client";

import type { ReactNode } from "react";
import { QueryBuilder } from "@/components/work-items/cql/query-builder";
import type { BoardQuery } from "./use-board-query";

/**
 * The board's filter bar with the query language on: the same chips and
 * editor as Issues (query design §12.1), under a line naming the board's own
 * scope, which the query narrows and "Clear" returns to. `children` holds
 * presentation controls that aren't filters (swimlanes).
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
   * The board's own actions, in this band's bottom row beside the pending
   * indicator. Same slot and same reason as `FilterBar`'s: these used to be a
   * second `<BoardToolbar>` band stacked underneath, holding two controls with
   * an empty middle. See ffe324aa.
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
  // No schema yet: show the actions alone rather than nothing, so they survive
  // a slow or failed /cql/schema. With nothing to put in it, still render
  // nothing -- an empty bordered strip where the filter bar belongs is the
  // failure `chrome-bands.arch.test.ts` was written about.
  if (!q.schema) {
    return actions ? (
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-2">
        {actions}
      </div>
    ) : null;
  }
  return (
    <div className="space-y-1 border-b border-[var(--border)] px-4 py-2">
      {/* `variant="inline"`: this band already draws the border and padding, so
          the builder's own card would be framing inside framing. Measured on
          prod, that card cost 26 of the band's 147 vertical pixels. */}
      <QueryBuilder
        orgId={orgId}
        schema={q.schema}
        cql={q.cql}
        onCqlChange={q.setCql}
        mode={q.mode}
        onModeChange={q.setMode}
        serverDiagnostics={q.diagnostics}
        variant="inline"
      />
      {/* One bottom row, not three stacked ones. The board's scope used to have
          a line of its own above the builder; it is small muted text that reads
          perfectly well beside the other small muted text, and a line to itself
          cost ~20px on every CQL board. A `problem` still gets priority here,
          and keeps role="alert".
          The builder's own Clear empties the query: back to the board's scope. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {q.problem ? (
          <p role="alert" className="text-xs text-[var(--status-blocked-text)]">
            This board shows nothing: {q.problem}.
          </p>
        ) : q.baselineCql ? (
          <p className="min-w-0 truncate text-xs text-[var(--text-muted)]" title={q.baselineCql}>
            This board shows{" "}
            <code className="rounded border border-[var(--border)] px-1">{q.baselineCql}</code>
          </p>
        ) : null}
        {children}
        <span aria-live="polite" className="text-xs text-[var(--text-muted)]">
          {q.pending ? "Filtering…" : ""}
        </span>
        {actions}
      </div>
    </div>
  );
}
