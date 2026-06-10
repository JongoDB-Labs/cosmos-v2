"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
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
import {
  usePermissions,
  Permission,
} from "@/components/providers/permissions-provider";
import { notifyError } from "@/lib/errors/notify";
import { ChevronUp, Plus, Bug, Lightbulb, Megaphone } from "lucide-react";

type FType = "BUG" | "FEATURE";
type FStatus = "OPEN" | "PLANNED" | "IN_PROGRESS" | "DONE" | "DECLINED";

interface FeedbackAttachment {
  id: string;
  kind: string;
  url: string;
  filename: string;
  contentType: string;
  size: number;
}

interface FeedbackItem {
  id: string;
  type: FType;
  title: string;
  description: string;
  status: FStatus;
  voteCount: number;
  hasVoted: boolean;
  createdAt: string;
  attachments?: FeedbackAttachment[];
}

const STATUS_LABELS: Record<FStatus, string> = {
  OPEN: "Open",
  PLANNED: "Planned",
  IN_PROGRESS: "In progress",
  DONE: "Done",
  DECLINED: "Declined",
};

const STATUS_ORDER: FStatus[] = [
  "OPEN",
  "PLANNED",
  "IN_PROGRESS",
  "DONE",
  "DECLINED",
];

export function FeedbackPortal({ orgId }: { orgId: string }) {
  const { can } = usePermissions();
  const canManage = can(Permission.ORG_UPDATE);
  const basePath = `/api/v1/orgs/${orgId}/feedback`;

  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Submit dialog.
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<FType>("FEATURE");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pending, setPending] = useState<
    { id: string; url: string; filename: string; kind: string }[]
  >([]);
  const [uploading, setUploading] = useState(false);

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!files.length) return;
    setUploading(true);
    try {
      for (const file of files.slice(0, 10)) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch(`${basePath}/attachments`, { method: "POST", body: fd });
        if (!res.ok) {
          notifyError(new Error("upload"), `Couldn't upload ${file.name}.`);
          continue;
        }
        const row = await res.json();
        setPending((prev) => [
          ...prev,
          { id: row.id, url: row.url, filename: row.filename, kind: row.kind },
        ]);
      }
    } finally {
      setUploading(false);
    }
  }

  function removePending(id: string) {
    setPending((prev) => prev.filter((a) => a.id !== id));
    void fetch(`${basePath}/attachments/${id}`, { method: "DELETE" }).catch(() => {});
  }

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(basePath);
      if (!res.ok) throw new Error("Failed to load feedback");
      setItems(await res.json());
    } catch (err) {
      notifyError(err, "Couldn't load feedback.");
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [basePath]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    fetchItems();
  }, [fetchItems]);
  /* eslint-enable react-hooks/set-state-in-effect */

  async function submit() {
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(basePath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          title: title.trim(),
          description: description.trim(),
          attachmentIds: pending.map((a) => a.id),
        }),
      });
      if (!res.ok) throw new Error("Failed to submit");
      setOpen(false);
      setType("FEATURE");
      setTitle("");
      setDescription("");
      setPending([]);
      await fetchItems();
    } catch (err) {
      notifyError(err, "Couldn't submit your feedback.");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleVote(item: FeedbackItem) {
    setBusyId(item.id);
    try {
      const res = await fetch(`${basePath}/${item.id}/vote`, {
        method: item.hasVoted ? "DELETE" : "POST",
      });
      if (!res.ok) throw new Error("Failed to vote");
      const { voteCount, hasVoted } = await res.json();
      setItems((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, voteCount, hasVoted } : i)),
      );
    } catch (err) {
      notifyError(err, "Couldn't record your vote.");
    } finally {
      setBusyId(null);
    }
  }

  async function changeStatus(item: FeedbackItem, status: FStatus) {
    setBusyId(item.id);
    try {
      const res = await fetch(`${basePath}/${item.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) throw new Error("Failed to update status");
      setItems((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, status } : i)),
      );
    } catch (err) {
      notifyError(err, "Couldn't update the status.");
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <p className="text-sm text-muted-foreground">Couldn&apos;t load feedback.</p>
        <Button variant="outline" size="sm" onClick={fetchItems}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4 mr-1" />
          Submit feedback
        </Button>
      </div>

      {items.length === 0 ? (
        <EmptyState
          illustration={<Megaphone className="size-10" />}
          title="No feedback yet"
          description="Be the first to request a feature or report a bug. Popular ideas rise to the top by votes."
        />
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <div
              key={item.id}
              className="flex items-start gap-3 rounded-lg border bg-card p-4"
            >
              {/* Vote control */}
              <button
                type="button"
                disabled={busyId === item.id}
                onClick={() => toggleVote(item)}
                aria-label={item.hasVoted ? "Remove vote" : "Upvote"}
                aria-pressed={item.hasVoted}
                className={`flex w-12 shrink-0 flex-col items-center rounded-md border px-2 py-1.5 transition-colors ${
                  item.hasVoted
                    ? "border-primary/50 bg-primary/10 text-primary"
                    : "hover:bg-muted text-muted-foreground"
                }`}
              >
                <ChevronUp className="h-4 w-4" />
                <span className="text-sm font-medium tabular-nums">
                  {item.voteCount}
                </span>
              </button>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="neutral" className="gap-1 text-[10px]">
                    {item.type === "BUG" ? (
                      <Bug className="h-3 w-3" />
                    ) : (
                      <Lightbulb className="h-3 w-3" />
                    )}
                    {item.type === "BUG" ? "Bug" : "Feature"}
                  </Badge>
                  <Badge
                    variant={item.status === "DONE" ? "progress" : "neutral"}
                    className="text-[10px]"
                  >
                    {STATUS_LABELS[item.status]}
                  </Badge>
                  <h3 className="font-medium text-sm truncate">{item.title}</h3>
                </div>
                {item.description && (
                  <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                    {item.description}
                  </p>
                )}
                {item.attachments && item.attachments.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {item.attachments.map((a) =>
                      a.kind === "image" ? (
                        <a
                          key={a.id}
                          href={a.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={a.filename}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={a.url}
                            alt={a.filename}
                            className="h-16 w-16 rounded border object-cover transition-opacity hover:opacity-80"
                          />
                        </a>
                      ) : (
                        <a
                          key={a.id}
                          href={a.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs underline underline-offset-2"
                        >
                          {a.filename}
                        </a>
                      ),
                    )}
                  </div>
                )}
                {canManage && (
                  <div className="mt-2">
                    <Select
                      value={item.status}
                      onValueChange={(v) =>
                        v && changeStatus(item, v as FStatus)
                      }
                    >
                      <SelectTrigger size="sm" className="h-7 w-36 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUS_ORDER.map((s) => (
                          <SelectItem key={s} value={s}>
                            {STATUS_LABELS[s]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Submit dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Submit feedback</DialogTitle>
            <DialogDescription>
              Request a feature or report a bug. Others can upvote it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="fb-type">Type</Label>
              <Select value={type} onValueChange={(v) => setType((v as FType) ?? "FEATURE")}>
                <SelectTrigger id="fb-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="FEATURE">Feature request</SelectItem>
                  <SelectItem value="BUG">Bug report</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fb-title">Title</Label>
              <Input
                id="fb-title"
                placeholder="Short summary…"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fb-desc">Details (optional)</Label>
              <Textarea
                id="fb-desc"
                placeholder="What happened, or what would you like?"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="min-h-[100px]"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fb-files">Screenshots (optional)</Label>
              <input
                id="fb-files"
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp,application/pdf"
                multiple
                onChange={handleFiles}
                disabled={uploading || pending.length >= 10}
                className="block w-full text-xs text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-xs file:font-medium hover:file:bg-muted/70"
              />
              {(uploading || pending.length > 0) && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {pending.map((a) => (
                    <div key={a.id} className="relative">
                      {a.kind === "image" ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={a.url}
                          alt={a.filename}
                          className="h-14 w-14 rounded border object-cover"
                        />
                      ) : (
                        <span className="flex h-14 w-14 items-center justify-center rounded border p-1 text-center text-[9px] leading-tight">
                          {a.filename}
                        </span>
                      )}
                      <button
                        type="button"
                        aria-label={`Remove ${a.filename}`}
                        onClick={() => removePending(a.id)}
                        className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-[10px] leading-none text-white"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {uploading && (
                    <span className="self-center text-xs text-muted-foreground">
                      Uploading…
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={submitting || !title.trim()}>
              {submitting ? "Submitting…" : "Submit"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
