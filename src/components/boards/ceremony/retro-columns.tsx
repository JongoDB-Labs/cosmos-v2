"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { cn } from "@/lib/utils";
import type { CeremonyColumn, CeremonyNote } from "./use-ceremony";

interface RetroColumnsProps {
  basePath: string;
  ceremonyId: string | null;
  columns: CeremonyColumn[];
  notes: CeremonyNote[];
  closed: boolean;
  invalidateParts: unknown[];
}

/**
 * The Start / Stop / Continue columns, drawn from the board's own BoardColumn
 * rows — so the column set, its order and its colour are all things a team can
 * edit, and a board using "Went well / Didn't / Try next" needs no new code.
 */
export function RetroColumns({
  basePath,
  ceremonyId,
  columns,
  notes,
  closed,
  invalidateParts,
}: RetroColumnsProps) {
  if (columns.length === 0) {
    return (
      <p className="text-sm text-[var(--text-muted)]">
        This board has no columns yet. Add them in board settings — they become
        the retro&apos;s prompts.
      </p>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {columns.map((column) => (
        <RetroColumn
          key={column.key}
          basePath={basePath}
          ceremonyId={ceremonyId}
          column={column}
          notes={notes.filter((n) => n.columnKey === column.key)}
          closed={closed}
          invalidateParts={invalidateParts}
        />
      ))}
    </div>
  );
}

function RetroColumn({
  basePath,
  ceremonyId,
  column,
  notes,
  closed,
  invalidateParts,
}: {
  basePath: string;
  ceremonyId: string | null;
  column: CeremonyColumn;
  notes: CeremonyNote[];
  closed: boolean;
  invalidateParts: unknown[];
}) {
  const [draft, setDraft] = useState("");

  const addNote = useOrgMutation<unknown, Error, string>({
    mutationFn: (text) =>
      jsonFetch(`${basePath}/ceremony/notes`, {
        method: "POST",
        body: JSON.stringify({ ceremonyId, columnKey: column.key, text }),
      }),
    invalidate: [invalidateParts],
    onSuccess: () => setDraft(""),
  });

  const deleteNote = useOrgMutation<unknown, Error, string>({
    mutationFn: (noteId) =>
      jsonFetch(`${basePath}/ceremony/notes/${noteId}`, { method: "DELETE" }),
    invalidate: [invalidateParts],
  });

  const canAdd = Boolean(ceremonyId) && !closed && draft.trim().length > 0;

  return (
    <section
      aria-label={column.name}
      className="flex flex-col rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]"
    >
      <header className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
        {/* The column's own colour, the same dot the outbrief uses per column. */}
        <span
          aria-hidden
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: column.color }}
        />
        <h3 className="text-sm font-semibold">{column.name}</h3>
        <span className="ml-auto text-xs tabular-nums text-[var(--text-muted)]">
          {notes.length}
        </span>
      </header>

      <ul className="flex-1 space-y-2 p-3">
        {notes.map((note) => (
          <li
            key={note.id}
            className="group relative rounded-[calc(var(--radius)-2px)] border border-[var(--border)] bg-[var(--bg,transparent)] p-3 text-sm"
          >
            <p className="whitespace-pre-wrap break-words pr-6">{note.text}</p>
            {/* Only the author sees a delete control; the facilitator's remove
                path is the API, which also allows it. */}
            {note.isMine && !closed ? (
              <button
                type="button"
                aria-label="Delete note"
                onClick={() => deleteNote.mutate(note.id)}
                className="absolute right-2 top-2 rounded p-1 text-[var(--text-muted)] opacity-0 transition-opacity hover:text-[var(--status-critical-text,var(--status-critical))] focus-visible:opacity-100 group-hover:opacity-100"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </li>
        ))}
        {notes.length === 0 ? (
          <li className="rounded-[calc(var(--radius)-2px)] border border-dashed border-[var(--border)] p-4 text-center text-xs text-[var(--text-muted)]">
            Nothing yet
          </li>
        ) : null}
      </ul>

      {closed ? null : (
        <form
          className="border-t border-[var(--border)] p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (canAdd) addNote.mutate(draft.trim());
          }}
        >
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Add to ${column.name}…`}
            aria-label={`Add a note to ${column.name}`}
            rows={2}
            maxLength={2000}
            // Enter submits: during a live retro people type fast and reaching
            // for a button between every thought slows the room down.
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (canAdd) addNote.mutate(draft.trim());
              }
            }}
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            className={cn("mt-2 w-full")}
            disabled={!canAdd || addNote.isPending}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add
          </Button>
        </form>
      )}
    </section>
  );
}
