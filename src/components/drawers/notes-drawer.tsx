"use client";

import { useCallback, useEffect, useState } from "react";
import {
  FileText,
  Plus,
  X,
  Lock,
  FolderKanban,
  Building2,
  ArrowLeft,
} from "lucide-react";
import { toast } from "sonner";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
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
 * Global slide-over for notes. Purpose-built for the ~460px drawer: a compact
 * list of the org's notes and a lightweight title + markdown-textarea editor
 * (NOT the full Lexical NoteEditor). Reads/writes the notes API:
 *   GET    /api/v1/orgs/[orgId]/notes            → Note[]
 *   POST   /api/v1/orgs/[orgId]/notes            → { title, content } (created)
 *   PUT    /api/v1/orgs/[orgId]/notes/[noteId]   → { title, content } (updated)
 */
export function NotesDrawer({ orgId }: NotesDrawerProps) {
  const { isOpen, close } = useDrawers();
  const open = isOpen("notes");

  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // null = list view. "new" = blank composer. A Note = editing that note.
  const [editing, setEditing] = useState<Note | null | "new">(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);

  const fetchNotes = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/notes`);
      if (!res.ok) throw new Error("Failed to load notes");
      // success() returns a bare array; tolerate a {notes:[...]} envelope too.
      const json: unknown = await res.json();
      const list = Array.isArray(json)
        ? (json as Note[])
        : ((json as { notes?: Note[] }).notes ?? []);
      setNotes(list);
    } catch (err) {
      notifyError(err, "Couldn't load notes.");
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  // Refresh the list whenever the drawer opens. fetchNotes sets loading state
  // synchronously — the established pattern — so scope-disable the rule here.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (open) fetchNotes();
  }, [open, fetchNotes]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function openEditor(note: Note | "new") {
    setEditing(note);
    setTitle(note === "new" ? "" : note.title);
    setContent(note === "new" ? "" : note.content);
  }

  function backToList() {
    setEditing(null);
    setTitle("");
    setContent("");
  }

  async function save() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle || saving || editing === null) return;
    setSaving(true);
    try {
      const isNew = editing === "new";
      const res = await fetch(
        isNew
          ? `/api/v1/orgs/${orgId}/notes`
          : `/api/v1/orgs/${orgId}/notes/${editing.id}`,
        {
          method: isNew ? "POST" : "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: trimmedTitle, content }),
        },
      );
      if (!res.ok) throw new Error("Failed to save note");
      const saved = (await res.json()) as Note;
      setNotes((prev) => {
        const exists = prev.find((n) => n.id === saved.id);
        return exists
          ? prev.map((n) => (n.id === saved.id ? saved : n))
          : [saved, ...prev];
      });
      toast.success(isNew ? "Note created." : "Note saved.");
      backToList();
    } catch (err) {
      notifyError(err, "Couldn't save the note.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          close();
          backToList();
        }
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        className="flex w-full flex-col p-0 sm:max-w-[460px]"
      >
        {editing !== null ? (
          /* ── Compact editor ── */
          <>
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
              <button
                type="button"
                onClick={backToList}
                aria-label="Back to notes"
                className="flex items-center gap-2 rounded p-1 text-sm font-semibold text-[var(--text)] hover:bg-[var(--primary-tint)]"
              >
                <ArrowLeft className="h-4 w-4 text-[var(--text-muted)]" />
                {editing === "new" ? "New note" : "Edit note"}
              </button>
              <button
                type="button"
                onClick={() => close()}
                aria-label="Close notes"
                className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--primary-tint)] hover:text-[var(--text)]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <form
                className="flex h-full flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Note title…"
                  aria-label="Note title"
                  autoComplete="off"
                />
                <Textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="Write your note in Markdown…"
                  aria-label="Note content"
                  className="min-h-[240px] flex-1 resize-none font-mono text-xs"
                />
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={backToList}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={saving || !title.trim()}
                  >
                    {saving
                      ? "Saving…"
                      : editing === "new"
                        ? "Create"
                        : "Save"}
                  </Button>
                </div>
              </form>
            </div>
          </>
        ) : (
          /* ── List view ── */
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
                  onClick={() => openEditor("new")}
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
                  <p className="text-sm text-[var(--text-muted)]">
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
                      onClick={() => openEditor("new")}
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
                        onClick={() => openEditor(note)}
                        className={cn(
                          "block w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-left transition-colors",
                          "hover:border-[var(--primary)]/50",
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-[var(--text-muted)]">
                            {visibilityIcon[note.visibility]}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text)]">
                            {note.title || "Untitled"}
                          </span>
                          <span className="shrink-0 text-[10px] text-[var(--text-muted)]">
                            {new Date(note.updatedAt).toLocaleDateString()}
                          </span>
                        </div>
                        {note.content && (
                          <p className="mt-1 line-clamp-2 text-xs text-[var(--text-muted)]">
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
