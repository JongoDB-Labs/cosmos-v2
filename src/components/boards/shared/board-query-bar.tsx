"use client";

import type { ReactNode } from "react";
import { QueryBuilder } from "@/components/work-items/cql/query-builder";
import type { BoardQuery } from "./use-board-query";

/**
 * The board's filter bar with the query language on: the same chips and
 * editor as Issues (query design §12.1), under a line naming the board's own
 * scope, which the query narrows and "Clear" returns to. `children` holds
 * presentation controls that aren't filters (swimlanes).
 */
export function BoardQueryBar({ orgId, q, children }: { orgId: string; q: BoardQuery; children?: ReactNode }) {
  if (!q.schema) return null;
  return (
    <div className="space-y-1.5 px-1 pb-2">
      {q.problem ? (
        <p role="alert" className="text-xs text-[var(--status-blocked-text)]">
          This board shows nothing: {q.problem}.
        </p>
      ) : q.baselineCql ? (
        <p className="text-xs text-[var(--text-muted)]">
          This board shows <code className="rounded border border-[var(--border)] px-1">{q.baselineCql}</code>
        </p>
      ) : null}
      <QueryBuilder
        orgId={orgId}
        schema={q.schema}
        cql={q.cql}
        onCqlChange={q.setCql}
        mode={q.mode}
        onModeChange={q.setMode}
        serverDiagnostics={q.diagnostics}
      />
      {/* The builder's own Clear empties the query: back to the board's scope. */}
      <div className="flex items-center gap-2">
        {children}
        <span aria-live="polite" className="text-xs text-[var(--text-muted)]">
          {q.pending ? "Filtering…" : ""}
        </span>
      </div>
    </div>
  );
}
