"use client";

import { useCallback, useEffect, useState } from "react";
import { FileText, Plus, X, Lock, FolderKanban, Building2 } from "lucide-react";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { NoteEditor } from "@/components/notes/note-editor";
import { stripMarkdown } from "@/components/notes/note-markdown";
import { notifyError } from "@/lib/errors/notify";
import { cn } from "@/lib/utils";
import type { Note } from "@/types/models";
import { useDrawers } from "./drawer-provider";

interface NotesDrawerProps {
  orgId: string;
}

const visibilityIcon: Record<Note["visibility"], React.ReactNode> = {
  PRIVATE: <Lock className="h-3 w-3" />,
  PROJECT: <FolderKanban className="h-3 w-3" />,
  ORG: <Building2 className="h-3 w-3" />,
};

/**
 * Global slide-over for notes. A compact list + quick create/edit that REUSES
 * the existing notes API (`/api/v1/orgs/[orgId]/notes`) and the shared
 * {@link NoteEditor} (Lexical rich-text + mentions) — the editor is NOT rebuilt.
 *
 * In list mode it shows a scrollable list of the org's notes; tapping one (or
 * "New") swaps the body to the full NoteEditor in-place.
 */
export function NotesDrawer({ orgId }: NotesDrawerProps) {
  const { isOpen, close } = useDrawers();
  const open = isOpen("notes");

  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState<Note | null | "new">(null);

  const fetchNotes = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/notes`);
      if (!res.ok) throw new Error("Failed to load notes");
      setNotes(await res.json());
    } catch (err) {
      notifyError(err, "Couldn't load notes.");
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  // Load (or refresh) the list whenever the drawer is opened. fetchNotes sets
  // loading state synchronously — the established pattern in FeedbackPortal —
  // so the set-state-in-effect rule is scoped-disabled here.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (open) fetchNotes();
  }, [open, fetchNotes]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function handleSave(saved: Note) {
    setNotes((prev) => {
      const existing = prev.find((n) => n.id === saved.id);
      return existing
        ? prev.map((n) => (n.id === saved.id ? saved : n))
        : [saved, ...prev];
    });
    setEditing(null);
  }

  function handleDelete(noteId: string) {
    setNotes((prev) => prev.filter((n) => n.id !== noteId));
    setEditing(null);
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          close();
          setEditing(null);
        }
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex w-full flex-col p-0 sm:max-w-[460px]"
      >
        {editing !== null ? (
          <NoteEditor
            note={editing === "new" ? null : editing}
            orgId={orgId}
            onSave={handleSave}
            onDelete={handleDelete}
            onClose={() => setEditing(null)}
          />
        ) : (
          <>
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
              <span className="flex items-center gap-2 text-sm font-semibold">
                <FileText className="h-4 w-4 text-[var(--primary)]" />
                Notes
              </span>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  className="h-7 gap-1.5"
                  onClick={() => setEditing("new")}
                >
                  <Plus className="h-3.5 w-3.5" />
                  New
                </Button>
                <button
                  type="button"
                  onClick={() => close()}
                  aria-label="Close notes"
                  className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--primary-tint)] hover:text-[var(--text)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {loading ? (
                <div className="space-y-2">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-16 w-full rounded-lg" />
                  ))}
                </div>
              ) : error ? (
                <div className="flex flex-col items-center gap-3 py-12 text-center">
                  <p className="text-sm text-muted-foreground">
                    Couldn&apos;t load notes.
                  </p>
                  <Button variant="outline" size="sm" onClick={fetchNotes}>
                    Try again
                  </Button>
                </div>
              ) : notes.length === 0 ? (
                <EmptyState
                  illustration={<FileText className="size-10" />}
                  title="No notes yet"
                  description="Capture a quick note without leaving your work."
                  action={
                    <Button
                      size="sm"
                      className="gap-1.5"
                      onClick={() => setEditing("new")}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      New Note
                    </Button>
                  }
                />
              ) : (
                <ul className="space-y-1.5">
                  {notes.map((note) => (
                    <li key={note.id}>
                      <button
                        type="button"
                        onClick={() => setEditing(note)}
                        className={cn(
                          "block w-full rounded-lg border bg-card p-3 text-left transition-colors",
                          "hover:border-primary/50",
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground">
                            {visibilityIcon[note.visibility]}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">
                            {note.title || "Untitled"}
                          </span>
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {new Date(note.updatedAt).toLocaleDateString()}
                          </span>
                        </div>
                        {note.content && (
                          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                            {stripMarkdown(note.content)}
                          </p>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
