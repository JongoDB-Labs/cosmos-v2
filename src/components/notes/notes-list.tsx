"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { notifyError } from "@/lib/errors/notify";
import { Plus, Search, Lock, Building2, FolderKanban, Pencil, Trash2 } from "lucide-react";
import { NoteEditor } from "./note-editor";
import { stripMarkdown } from "./note-markdown";
import { EmptyState } from "@/components/ui/empty-state";
import { ActionMenu, type ActionMenuGroup } from "@/components/ui/action-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import type { Note } from "@/types/models";

interface NotesListProps {
  orgId: string;
}

type VisibilityFilter = "ALL" | "PRIVATE" | "PROJECT" | "ORG";

const visibilityIcons: Record<Note["visibility"], React.ReactNode> = {
  PRIVATE: <Lock className="h-3 w-3" />,
  PROJECT: <FolderKanban className="h-3 w-3" />,
  ORG: <Building2 className="h-3 w-3" />,
};

const visibilityLabels: Record<Note["visibility"], string> = {
  PRIVATE: "Private",
  PROJECT: "Project",
  ORG: "Organization",
};

export function NotesList({ orgId }: NotesListProps) {
  const { can } = usePermissions();
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<VisibilityFilter>("ALL");
  const [editingNote, setEditingNote] = useState<Note | null | "new">(null);
  const [pendingDelete, setPendingDelete] = useState<Note | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function fetchNotes() {
      setLoading(true);
      setError(null);

      try {
        const res = await fetch(`/api/v1/orgs/${orgId}/notes`);
        if (!res.ok) throw new Error("Failed to load notes");
        const data: Note[] = await res.json();
        if (!cancelled) setNotes(data);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unknown error");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchNotes();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const filteredNotes = notes.filter((note) => {
    if (filter !== "ALL" && note.visibility !== filter) return false;
    if (
      search &&
      !note.title.toLowerCase().includes(search.toLowerCase()) &&
      !note.content.toLowerCase().includes(search.toLowerCase())
    ) {
      return false;
    }
    return true;
  });

  function handleSave(saved: Note) {
    setNotes((prev) => {
      const existing = prev.find((n) => n.id === saved.id);
      if (existing) {
        return prev.map((n) => (n.id === saved.id ? saved : n));
      }
      return [saved, ...prev];
    });
    setEditingNote(null);
  }

  function handleDelete(noteId: string) {
    // Local-only removal: used by NoteEditor's onDelete, which has ALREADY
    // performed the DELETE request before calling back.
    setNotes((prev) => prev.filter((n) => n.id !== noteId));
    setEditingNote(null);
  }

  // The card action-menu deletes directly (no editor), so it must call the API
  // itself — optimistically remove, then revert + notify if the server rejects.
  async function deleteNoteById(noteId: string) {
    const idx = notes.findIndex((n) => n.id === noteId);
    const removed = notes[idx];
    setNotes((p) => p.filter((n) => n.id !== noteId));
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/notes/${noteId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`Failed to delete note (HTTP ${res.status})`);
    } catch (err) {
      console.error("Failed to delete note:", err);
      // Re-insert only THIS note (functional update — a whole-array snapshot
      // restore would clobber a concurrent delete).
      if (removed) {
        setNotes((p) => {
          const next = [...p];
          next.splice(Math.min(idx, next.length), 0, removed);
          return next;
        });
      }
      notifyError(err, "Couldn't delete the note.");
    }
  }

  // Direct visibility change (PRIVATE / ORG) without opening the editor.
  // PROJECT visibility needs a project selection, so it stays in the editor.
  async function setNoteVisibility(note: Note, visibility: Note["visibility"]) {
    if (note.visibility === visibility) return;
    const prev = note.visibility;
    setNotes((p) =>
      p.map((n) => (n.id === note.id ? { ...n, visibility } : n)),
    );
    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/notes/${note.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility }),
      });
      if (!res.ok) throw new Error(`Failed (HTTP ${res.status})`);
    } catch (err) {
      setNotes((p) =>
        p.map((n) => (n.id === note.id ? { ...n, visibility: prev } : n)),
      );
      notifyError(err, "Couldn't change the note's visibility.");
    }
  }

  // Show editor if editing
  if (editingNote !== null) {
    return (
      <NoteEditor
        note={editingNote === "new" ? null : editingNote}
        orgId={orgId}
        onSave={handleSave}
        onDelete={handleDelete}
        onClose={() => setEditingNote(null)}
      />
    );
  }

  if (loading) {
    return <NotesListSkeleton />;
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-sm text-destructive mb-2">Failed to load notes</p>
          <p className="text-xs text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  const filterTabs: { key: VisibilityFilter; label: string }[] = [
    { key: "ALL", label: "All" },
    { key: "PRIVATE", label: "Private" },
    { key: "ORG", label: "Org" },
  ];

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-end mb-6">
        {/* Title owned by the page shell (PageShell). */}
        <Button onClick={() => setEditingNote("new")} className="gap-2">
          <Plus className="h-4 w-4" />
          New Note
        </Button>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search notes..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
          />
        </div>

        <div className="flex items-center gap-1 rounded-lg border p-0.5">
          {filterTabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setFilter(tab.key)}
              className={cn(
                "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                filter === tab.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {filteredNotes.length === 0 ? (
        notes.length === 0 ? (
          <EmptyState
            title="No notes yet"
            description="Create your first note to start capturing knowledge for the workspace."
            action={
              <Button onClick={() => setEditingNote("new")} className="gap-2">
                <Plus className="h-4 w-4" />
                Create Note
              </Button>
            }
          />
        ) : (
          <EmptyState
            title="No matching notes"
            description="Try adjusting your search or filter."
          />
        )
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredNotes.map((note) => {
            const groups: ActionMenuGroup[] = [
              {
                items: [
                  ...(can(Permission.NOTE_UPDATE)
                    ? [
                        {
                          label: "Edit",
                          icon: Pencil,
                          onClick: () => setEditingNote(note),
                        },
                      ]
                    : []),
                ],
              },
              ...(can(Permission.NOTE_UPDATE) && note.visibility !== "PRIVATE"
                ? [
                    {
                      items: [
                        {
                          label: "Make private",
                          icon: Lock,
                          onClick: () => setNoteVisibility(note, "PRIVATE"),
                        },
                      ],
                    },
                  ]
                : []),
              ...(can(Permission.NOTE_UPDATE) && note.visibility !== "ORG"
                ? [
                    {
                      items: [
                        {
                          label: "Share with organization",
                          icon: Building2,
                          onClick: () => setNoteVisibility(note, "ORG"),
                        },
                      ],
                    },
                  ]
                : []),
              {
                items: [
                  ...(can(Permission.NOTE_DELETE)
                    ? [
                        {
                          label: "Delete",
                          icon: Trash2,
                          variant: "destructive" as const,
                          onClick: () => setPendingDelete(note),
                        },
                      ]
                    : []),
                ],
              },
            ];

            return (
              // Wrap in a real grid-item box: ActionMenu uses `display:contents`,
              // which would otherwise promote its (opacity-0) trigger button into
              // THIS grid, rendering as an invisible-but-clickable phantom cell.
              // The wrapper also carries `group/action` so the trigger — a sibling
              // of the card, not a descendant — actually reveals on hover.
              <div key={note.id} className="group/action relative">
                <ActionMenu
                  groups={groups}
                  triggerClassName="absolute right-2 top-2 z-10"
                >
                  <button
                    onClick={() => setEditingNote(note)}
                    className="block w-full text-left rounded-lg border bg-card p-4 hover:border-primary/50 transition-colors"
                  >
                    {/* pr-6 leaves room for the hover ⋯ menu button */}
                    <h3 className="font-medium text-sm truncate pr-6">{note.title}</h3>
                    {note.content && (
                      <p className="text-xs text-muted-foreground mt-2 line-clamp-3">
                        {stripMarkdown(note.content)}
                      </p>
                    )}
                    <div className="mt-3 flex items-center justify-between gap-2">
                      <Badge variant="neutral" className="shrink-0 gap-1">
                        {visibilityIcons[note.visibility]}
                        {visibilityLabels[note.visibility]}
                      </Badge>
                      <p className="text-[10px] text-muted-foreground">
                        {new Date(note.updatedAt).toLocaleDateString()}
                      </p>
                    </div>
                  </button>
                </ActionMenu>
              </div>
            );
          })}
        </div>
      )}

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(o) => {
          if (!o && !deleting) setPendingDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete note?</DialogTitle>
            <DialogDescription>
              This permanently deletes{" "}
              {pendingDelete?.title ? `"${pendingDelete.title}"` : "this note"}.
              This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingDelete(null)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={async () => {
                if (!pendingDelete) return;
                setDeleting(true);
                await deleteNoteById(pendingDelete.id);
                setDeleting(false);
                setPendingDelete(null);
              }}
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function NotesListSkeleton() {
  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-28" />
      </div>
      <div className="flex items-center gap-3 mb-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-8 w-32" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-32 rounded-lg" />
        ))}
      </div>
    </div>
  );
}
