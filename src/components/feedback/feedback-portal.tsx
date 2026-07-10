"use client";

import { useState, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useOrgQueryKey } from "@/lib/query/keys";
import { jsonFetch } from "@/lib/query/json-fetcher";
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
import { ChevronUp, Plus, Bug, Lightbulb, Megaphone, Pencil, Trash2 } from "lucide-react";

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
  // True when the current user authored this item — they own its title/
  // description and may delete it, regardless of ORG_UPDATE.
  isMine: boolean;
  createdAt: string;
  attachments?: FeedbackAttachment[];
  projectId?: string | null;
  // Submitter identity (resolved server-side — FeedbackItem has no User
  // relation). Prefer the display name, falling back to email; either can be
  // null if the author's User row no longer exists.
  authorName?: string | null;
  authorEmail?: string | null;
}

/** "Reported by <name>", preferring display name and falling back to email.
 *  Returns null when neither resolved (e.g. the author's User row is gone). */
function reporterLabel(item: Pick<FeedbackItem, "authorName" | "authorEmail">): string | null {
  const who = item.authorName || item.authorEmail;
  return who ? `Reported by ${who}` : null;
}

// Shape of /api/v1/orgs/[orgId]/projects — `success(projects)` returns a bare
// array (jsonFetch unwraps the `{ data }` envelope), so this is one element.
type OrgProject = { id: string; key: string; name: string };

// Sentinel for the project picker's "no project" option — the portal is an
// org-level surface with no implicit "current project" to default to.
const NO_PROJECT = "__none__";

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

  // Org's live projects, for the submit dialog's project picker. Member-
  // accessible (PROJECT_READ, which every org role down to MEMBER has) —
  // NOT the ORG_UPDATE-gated remediation-config endpoint. Shares the
  // "projects" cache key with the sidebar/chat dialogs, so this is typically
  // served from an already-warm cache entry rather than a fresh fetch.
  const projectsKey = useOrgQueryKey("projects");
  const { data: projects } = useQuery({
    queryKey: projectsKey,
    queryFn: () => jsonFetch<OrgProject[]>(`/api/v1/orgs/${orgId}/projects`),
    staleTime: 60_000,
  });

  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Click an item to open its full detail (FR: "click on the FR and a modal
  // pops up to show all the details"). Track by id + derive from `items` so the
  // dialog's vote count / status stay live as the user votes or triages.
  const [detailId, setDetailId] = useState<string | null>(null);
  const detailItem = detailId
    ? items.find((i) => i.id === detailId) ?? null
    : null;
  // Manager edit/delete of an item from the detail modal.
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Filter + sort (FR: organize/filter FRs & BRs by status and type).
  const [filterType, setFilterType] = useState<"ALL" | FType>("ALL");
  const [filterStatus, setFilterStatus] = useState<"ALL" | FStatus>("ALL");
  const [sortBy, setSortBy] = useState<"votes" | "newest">("votes");
  const [search, setSearch] = useState("");

  // Submit dialog.
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<FType>("FEATURE");
  const [newProjectId, setNewProjectId] = useState<string | null>(null);
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
          projectId: newProjectId,
        }),
      });
      if (!res.ok) throw new Error("Failed to submit");
      setOpen(false);
      setType("FEATURE");
      setNewProjectId(null);
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

  // FR "edit/delete FRs/BRs in the feedback section" (managers, ORG_UPDATE).
  async function saveEdit(item: FeedbackItem, title: string, description: string) {
    setBusyId(item.id);
    try {
      const res = await fetch(`${basePath}/${item.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), description }),
      });
      if (!res.ok) throw new Error("Failed to save");
      setItems((prev) =>
        prev.map((i) =>
          i.id === item.id ? { ...i, title: title.trim(), description } : i,
        ),
      );
      setEditing(false);
    } catch (err) {
      notifyError(err, "Couldn't save the changes.");
    } finally {
      setBusyId(null);
    }
  }

  async function deleteItem(item: FeedbackItem) {
    setBusyId(item.id);
    try {
      const res = await fetch(`${basePath}/${item.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      setDetailId(null);
      setConfirmDeleteId(null);
    } catch (err) {
      notifyError(err, "Couldn't delete the item.");
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

  const q = search.trim().toLowerCase();
  const visibleItems = items
    .filter((i) => filterType === "ALL" || i.type === filterType)
    .filter((i) => filterStatus === "ALL" || i.status === filterStatus)
    .filter(
      (i) =>
        q === "" ||
        i.title.toLowerCase().includes(q) ||
        i.description.toLowerCase().includes(q),
    )
    .slice()
    .sort((a, b) => {
      if (sortBy === "votes" && b.voteCount !== a.voteCount) {
        return b.voteCount - a.voteCount;
      }
      // tiebreak / "newest" → most recent first
      return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
    });

  const selectCls =
    "rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text)] outline-none focus-visible:border-[var(--primary)]";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search feedback…"
            aria-label="Search feedback"
            className={`${selectCls} w-44 py-1`}
          />
          <label className="flex items-center gap-1">
            Type
            <select
              aria-label="Filter by type"
              className={selectCls}
              value={filterType}
              onChange={(e) => setFilterType(e.target.value as "ALL" | FType)}
            >
              <option value="ALL">All</option>
              <option value="FEATURE">Features</option>
              <option value="BUG">Bugs</option>
            </select>
          </label>
          <label className="flex items-center gap-1">
            Status
            <select
              aria-label="Filter by status"
              className={selectCls}
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as "ALL" | FStatus)}
            >
              <option value="ALL">All</option>
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            Sort
            <select
              aria-label="Sort by"
              className={selectCls}
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as "votes" | "newest")}
            >
              <option value="votes">Top voted</option>
              <option value="newest">Newest</option>
            </select>
          </label>
        </div>
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
      ) : visibleItems.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          No {filterType === "ALL" ? "feedback" : filterType === "BUG" ? "bugs" : "features"}
          {filterStatus !== "ALL" ? ` that are ${STATUS_LABELS[filterStatus].toLowerCase()}` : ""}.
        </div>
      ) : (
        <div className="space-y-2">
          {visibleItems.map((item) => (
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
                <button
                  type="button"
                  onClick={() => setDetailId(item.id)}
                  className="block w-full text-left group/fb"
                  aria-label={`View details for "${item.title}"`}
                >
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
                    <h3 className="font-medium text-sm truncate group-hover/fb:underline">
                      {item.title}
                    </h3>
                    {reporterLabel(item) && (
                      <span className="text-[10px] text-muted-foreground">
                        {reporterLabel(item)}
                      </span>
                    )}
                  </div>
                  {item.description && (
                    <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                      {item.description}
                    </p>
                  )}
                </button>
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
              <Label htmlFor="fb-project">Project</Label>
              <Select
                value={newProjectId ?? NO_PROJECT}
                onValueChange={(v) => setNewProjectId(v === NO_PROJECT ? null : v)}
              >
                <SelectTrigger id="fb-project">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PROJECT}>App-wide / unassigned</SelectItem>
                  {(projects ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.key} · {p.name}
                    </SelectItem>
                  ))}
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

      {/* Detail dialog — full view of a single item (FR: "click on the FR → modal with all the details"). */}
      <Dialog
        open={detailItem !== null}
        onOpenChange={(o) => {
          if (!o) {
            setDetailId(null);
            setEditing(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          {detailItem && (
            <>
              <DialogHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="neutral" className="gap-1 text-[10px]">
                    {detailItem.type === "BUG" ? (
                      <Bug className="h-3 w-3" />
                    ) : (
                      <Lightbulb className="h-3 w-3" />
                    )}
                    {detailItem.type === "BUG" ? "Bug" : "Feature"}
                  </Badge>
                  <Badge
                    variant={detailItem.status === "DONE" ? "progress" : "neutral"}
                    className="text-[10px]"
                  >
                    {STATUS_LABELS[detailItem.status]}
                  </Badge>
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <ChevronUp className="h-3 w-3" />
                    {detailItem.voteCount}
                  </span>
                </div>
                <DialogTitle className="pt-1 text-base">
                  {detailItem.title}
                </DialogTitle>
                <DialogDescription>
                  Submitted{" "}
                  {new Date(detailItem.createdAt).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                  {reporterLabel(detailItem) && ` · ${reporterLabel(detailItem)}`}
                </DialogDescription>
              </DialogHeader>

              <div className="max-h-[55vh] space-y-4 overflow-y-auto">
                {editing ? (
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="fb-edit-title">Title</Label>
                      <Input
                        id="fb-edit-title"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="fb-edit-desc">Details</Label>
                      <Textarea
                        id="fb-edit-desc"
                        value={editDesc}
                        onChange={(e) => setEditDesc(e.target.value)}
                        className="min-h-[120px]"
                      />
                    </div>
                  </div>
                ) : detailItem.description ? (
                  <p className="text-sm whitespace-pre-wrap text-foreground/90">
                    {detailItem.description}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground italic">
                    No additional details were provided.
                  </p>
                )}

                {detailItem.attachments && detailItem.attachments.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">
                      Attachments
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {detailItem.attachments.map((a) =>
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
                              className="h-24 w-24 rounded border object-cover transition-opacity hover:opacity-80"
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
                  </div>
                )}
              </div>

              <DialogFooter className="sm:justify-between">
                <button
                  type="button"
                  disabled={busyId === detailItem.id}
                  onClick={() => toggleVote(detailItem)}
                  aria-pressed={detailItem.hasVoted}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors ${
                    detailItem.hasVoted
                      ? "border-primary/50 bg-primary/10 text-primary"
                      : "hover:bg-muted text-muted-foreground"
                  }`}
                >
                  <ChevronUp className="h-4 w-4" />
                  {detailItem.hasVoted ? "Voted" : "Upvote"} · {detailItem.voteCount}
                </button>
                {/* Author owns title/description edits + delete; a manager owns
                    status triage + delete. Each control shows only for the
                    authority that backs it, mirroring the API. */}
                {(canManage || detailItem.isMine) &&
                  (editing ? (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setEditing(false)}
                        disabled={busyId === detailItem.id}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => saveEdit(detailItem, editTitle, editDesc)}
                        disabled={busyId === detailItem.id || !editTitle.trim()}
                      >
                        Save
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      {detailItem.isMine && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Edit"
                          title="Edit"
                          onClick={() => {
                            setEditTitle(detailItem.title);
                            setEditDesc(detailItem.description ?? "");
                            setEditing(true);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Delete"
                        title="Delete"
                        onClick={() => setConfirmDeleteId(detailItem.id)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                      {canManage && (
                        <Select
                          value={detailItem.status}
                          onValueChange={(v) => v && changeStatus(detailItem, v as FStatus)}
                        >
                          <SelectTrigger size="sm" className="h-8 w-32 text-xs">
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
                      )}
                    </div>
                  ))}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog
        open={confirmDeleteId !== null}
        onOpenChange={(o) => !o && setConfirmDeleteId(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this feedback?</DialogTitle>
            <DialogDescription>
              This permanently removes the item and its votes. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDeleteId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busyId === confirmDeleteId}
              onClick={() => {
                const target = items.find((i) => i.id === confirmDeleteId);
                if (target) void deleteItem(target);
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
