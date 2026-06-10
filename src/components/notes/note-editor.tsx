"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useOrgMembers } from "@/components/chat/mention-typeahead";
import { NoteRichTextEditor } from "./editor/rich-text-editor";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, Trash2 } from "lucide-react";
import { notifyError } from "@/lib/errors/notify";
import type { Note } from "@/types/models";

interface NoteEditorProps {
  note: Note | null;
  orgId: string;
  onSave: (note: Note) => void;
  onDelete: (noteId: string) => void;
  onClose: () => void;
}

// NOTE: "PROJECT" visibility is intentionally NOT offered. The Note model has
// no projectId, so a PROJECT note isn't actually scoped to any project — the
// list query treats it identically to ORG, which made the option misleading.
// Legacy PROJECT notes still render (see visibilityLabels), and editing one
// normalizes it to ORG on open (its real, equivalent behavior).
const visibilityOptions: { value: Note["visibility"]; label: string }[] = [
  { value: "PRIVATE", label: "Private" },
  { value: "ORG", label: "Organization" },
];

export function NoteEditor({
  note,
  orgId,
  onSave,
  onDelete,
  onClose,
}: NoteEditorProps) {
  const [title, setTitle] = useState(note?.title ?? "");
  // Canonical content stays markdown; the rich-text editor imports this once and
  // exports markdown back through onChange.
  const [content, setContent] = useState(note?.content ?? "");
  const [visibility, setVisibility] = useState<Note["visibility"]>(
    // Coerce legacy PROJECT → ORG so the (now PROJECT-less) Select has a valid
    // selection; PROJECT always behaved as ORG anyway.
    note?.visibility === "PROJECT" ? "ORG" : (note?.visibility ?? "PRIVATE"),
  );
  const [saving, setSaving] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  // The editor imports `<@uuid>` mentions and needs member display names to
  // render them, so it only mounts once members have loaded.
  const { data: mentionMembers } = useOrgMembers(orgId);

  const isNew = !note;

  async function handleSave() {
    if (!title.trim()) return;
    setSaving(true);

    try {
      const url = isNew
        ? `/api/v1/orgs/${orgId}/notes`
        : `/api/v1/orgs/${orgId}/notes/${note.id}`;

      const res = await fetch(url, {
        method: isNew ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          content,
          visibility,
        }),
      });

      if (!res.ok) throw new Error("Failed to save note");

      const saved: Note = await res.json();
      onSave(saved);
    } catch (err) {
      console.error("Failed to save note:", err);
      notifyError(err, "Couldn't save the note.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!note) return;

    try {
      const res = await fetch(`/api/v1/orgs/${orgId}/notes/${note.id}`, {
        method: "DELETE",
      });

      if (!res.ok) throw new Error("Failed to delete note");

      onDelete(note.id);
    } catch (err) {
      console.error("Failed to delete note:", err);
      notifyError(err, "Couldn't delete the note.");
    } finally {
      setShowDeleteDialog(false);
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h2 className="text-sm font-medium">
            {isNew ? "New Note" : "Edit Note"}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          {!isNew && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setShowDeleteDialog(true)}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              Delete
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={saving || !title.trim()}
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col p-4 gap-4 max-w-4xl mx-auto w-full">
        <Input
          placeholder="Note title..."
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="text-lg font-medium border-none px-0 focus-visible:ring-0 focus-visible:border-transparent"
        />

        <div className="flex items-center gap-3">
          <Label className="text-xs text-muted-foreground shrink-0">
            Visibility
          </Label>
          <Select
            value={visibility}
            onValueChange={(v) => setVisibility(v as Note["visibility"])}
          >
            <SelectTrigger className="w-36" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {visibilityOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-1 min-h-0 flex-col">
          {mentionMembers ? (
            <NoteRichTextEditor
              key={note?.id ?? "new"}
              initialMarkdown={note?.content ?? ""}
              members={mentionMembers}
              onChange={setContent}
            />
          ) : (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-8 w-48" />
              <Skeleton className="h-[300px] w-full" />
            </div>
          )}
        </div>
      </div>

      <Dialog
        open={showDeleteDialog}
        onOpenChange={(open) => {
          if (!open) setShowDeleteDialog(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Are you sure?</DialogTitle>
            <DialogDescription>
              This will permanently delete this note. This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
