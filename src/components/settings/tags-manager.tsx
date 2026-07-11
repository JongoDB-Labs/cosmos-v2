"use client";

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AlertTriangle, Check, Loader2, Plus, Tags, Trash2 } from "lucide-react";
import { notifyError } from "@/lib/errors/notify";
import { LoadError } from "@/components/ui/load-error";
import type { TagDef } from "@/lib/work-items/tags";

/** A small, tasteful preset palette. Color is optional — "None" is the default. */
const TAG_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899", "#64748b",
];

/** A colored chip — a dot in the tag's color (or a hollow ring when uncolored). */
function TagChip({ tag }: { tag: TagDef }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-2.5 py-0.5 text-xs font-medium">
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full border border-black/10"
        style={{ backgroundColor: tag.color ?? "transparent" }}
      />
      {tag.name}
    </span>
  );
}

export function TagsManager({ orgId }: { orgId: string }) {
  const [tags, setTags] = useState<TagDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(null);

  const [deleting, setDeleting] = useState<TagDef | null>(null);

  const apiBase = `/api/v1/orgs/${orgId}/tags`;

  const fetchTags = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch(apiBase);
      if (!res.ok) throw new Error();
      const json = await res.json();
      setTags(Array.isArray(json) ? json : json.data ?? []);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [apiBase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchTags();
  }, [fetchTags]);

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSubmitting(true);
    try {
      const res = await fetch(apiBase, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, color }),
      });
      if (!res.ok) throw new Error("Couldn't save the tag.");
      const json = await res.json();
      setTags(Array.isArray(json) ? json : json.data ?? []);
      setName("");
      setColor(null);
    } catch (err) {
      notifyError(err, "Couldn't save the tag.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!deleting) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${apiBase}?name=${encodeURIComponent(deleting.name)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Couldn't delete the tag.");
      const json = await res.json();
      setTags(Array.isArray(json) ? json : json.data ?? []);
      setDeleting(null);
    } catch (err) {
      notifyError(err, "Couldn't delete the tag.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex items-center justify-center py-12">
        <LoadError onRetry={() => { void fetchTags(); }} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Create form */}
      <form
        className="flex flex-col gap-3 rounded-lg border p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void handleCreate();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tag-name">New tag</Label>
          <div className="flex gap-2">
            <Input
              id="tag-name"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Backend"
              className="max-w-xs"
            />
            <Button type="submit" disabled={!name.trim() || submitting}>
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : (
                <Plus className="h-4 w-4 mr-1" />
              )}
              Add tag
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Color (optional)</Label>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => setColor(null)}
              title="No color"
              aria-pressed={color === null}
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full border text-muted-foreground",
                color === null ? "ring-2 ring-ring ring-offset-1" : "border-[var(--border)]",
              )}
            >
              {color === null && <Check className="h-3.5 w-3.5" />}
            </button>
            {TAG_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                title={c}
                aria-pressed={color === c}
                style={{ backgroundColor: c }}
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-full border border-black/10",
                  color === c && "ring-2 ring-ring ring-offset-1",
                )}
              >
                {color === c && <Check className="h-3.5 w-3.5 text-white" />}
              </button>
            ))}
          </div>
        </div>
      </form>

      {/* Tag list */}
      {tags.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-12">
          <Tags className="h-10 w-10 text-muted-foreground/40" />
          <div className="text-center">
            <p className="text-sm font-medium text-muted-foreground">No tags yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Create a tag above, then assign it to tasks.
            </p>
          </div>
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {tags.map((tag) => (
            <li
              key={tag.name}
              className="flex items-center justify-between rounded-md border px-3 py-2 hover:bg-muted/30"
            >
              <TagChip tag={tag} />
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setDeleting(tag)}
                title="Delete tag"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* Delete confirmation */}
      <Dialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Delete tag
            </DialogTitle>
            <DialogDescription>
              Delete <strong>&ldquo;{deleting?.name}&rdquo;</strong>? It will be removed from
              every task it&rsquo;s assigned to. This can&rsquo;t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={submitting}>
              {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
