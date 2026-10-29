"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useOrgQueryKey } from "@/lib/query/keys";
import { jsonFetch, FetchError } from "@/lib/query/json-fetcher";
import { useRealtimeEvents } from "@/hooks/use-realtime-events";
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
import { reportError } from "@/lib/telemetry/error-report";
import { describeUploadError, networkUploadError } from "./upload-error";
import { FeedbackDetailDialog } from "./feedback-detail-dialog";
import {
  INTAKE_BADGE_VARIANT,
  STATUS_LABELS,
  STATUS_ORDER,
  reporterLabel,
  type FeedbackItem,
  type FStatus,
  type FType,
} from "./feedback-types";
import { ChevronUp, Plus, Bug, Lightbulb, Megaphone, MessageSquare } from "lucide-react";
import { ACCEPT_ATTRIBUTE } from "@/lib/storage/upload-policy";

// Shape of /api/v1/orgs/[orgId]/projects — `success(projects)` returns a bare
// array (jsonFetch unwraps the `{ data }` envelope), so this is one element.
type OrgProject = { id: string; key: string; name: string };

// Sentinel for the project picker's "no project" option — the portal is an
// org-level surface with no implicit "current project" to default to.
const NO_PROJECT = "__none__";


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
  // Read by fetchItems, which must not drop the open item (see there).
  const detailIdRef = useRef<string | null>(null);
  useEffect(() => {
    detailIdRef.current = detailId;
  }, [detailId]);
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Filter + sort (FR: organize/filter FRs & BRs by status and type).
  // Status is a multi-select: the set holds every status to show, and an empty
  // set means "no status filter" (the full, unfiltered list). Type stays a
  // single choice (All / Features / Bugs) since an item is one or the other.
  const [filterType, setFilterType] = useState<"ALL" | FType>("ALL");
  const [statusFilter, setStatusFilter] = useState<Set<FStatus>>(
    () => new Set(),
  );
  const [sortBy, setSortBy] = useState<"votes" | "newest">("votes");
  const [search, setSearch] = useState("");

  // Toggle one status in/out of the multi-select filter.
  function toggleStatus(s: FStatus) {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

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

        let res: Response;
        try {
          res = await fetch(`${basePath}/attachments`, { method: "POST", body: fd });
        } catch (netErr) {
          // The request never completed (offline, dropped connection, proxy
          // reset). Without this catch it escapes as an unhandled rejection and
          // the user sees nothing at all.
          const err = netErr instanceof Error ? netErr : new Error("upload network error");
          reportError(err, {
            scope: "feedback.attachment",
            phase: "network",
            filename: file.name,
          });
          notifyError(err, networkUploadError(file.name));
          continue;
        }

        if (!res.ok) {
          // Pull the server's structured reason ({ error, maxBytes }) so we can
          // tell the user WHY and record the status/code for diagnosis. The body
          // may be non-JSON for an infra error (nginx/Cloudflare) — tolerate it.
          let code: string | null = null;
          let maxBytes: number | null = null;
          try {
            const body: unknown = await res.json();
            if (body && typeof body === "object") {
              const b = body as Record<string, unknown>;
              code = typeof b.error === "string" ? b.error : null;
              maxBytes = typeof b.maxBytes === "number" ? b.maxBytes : null;
            }
          } catch {
            /* non-JSON error body — the HTTP status alone drives the message */
          }
          const err = new Error(`feedback attachment upload failed (${res.status})`);
          reportError(err, {
            scope: "feedback.attachment",
            status: res.status,
            code,
            filename: file.name,
          });
          notifyError(
            err,
            describeUploadError({ filename: file.name, status: res.status, code, maxBytes }),
          );
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
      const list: FeedbackItem[] = await res.json();
      // The list is the top 200. An item opened from a deep link can sit
      // outside it, and a refetch (any realtime event) would otherwise drop it
      // and close the dialog out from under the reader.
      setItems((prev) => {
        const openId = detailIdRef.current;
        if (!openId || list.some((i) => i.id === openId)) return list;
        const open = prev.find((i) => i.id === openId);
        return open ? [...list, open] : list;
      });
    } catch (err) {
      notifyError(err, "Couldn't load feedback.");
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [basePath]);

  // Live updates (COSMOS-129): re-pull the feedback list when the guardrail intake
  // pipeline records a decision (held/throttled/gated/flagged/duplicate/rejected) or a
  // delivered FR/BR becomes a work item — so the board reflects submissions, triage,
  // and delivery in real time without a manual refresh. Handlers are read from a ref
  // inside the hook, so re-creating this object each render doesn't reopen the stream.
  useRealtimeEvents(orgId, {
    "feedback.delivered": () => void fetchItems(),
    "feedback.merged": () => void fetchItems(),
    "feedback.unmerged": () => void fetchItems(),
    "feedback.throttled": () => void fetchItems(),
    "feedback.gated": () => void fetchItems(),
    "feedback.flagged": () => void fetchItems(),
    "feedback.duplicate": () => void fetchItems(),
    "work-item.created": () => void fetchItems(),
  });

  // Deep link: `/feedback?item=<id>` opens that item, which every feedback
  // notification now links to. Fetch the single item (it may be outside the
  // list's top 200), open it, then strip the param so closing does not reopen
  // it. Same shape as the Issues view's `?item=` (COSMOS-191), guard included:
  // the strip re-runs this effect, and the guard keeps it from refetching.
  const router = useRouter();
  const searchParams = useSearchParams();
  const handledDeepLinkRef = useRef<string | null>(null);
  // Fetch one item (it may be outside the list's top 200, or merged and so
  // hidden from it), put it in the list and open it.
  const openItemById = useCallback(
    (itemId: string) =>
      jsonFetch<FeedbackItem>(`${basePath}/${encodeURIComponent(itemId)}`).then((item) => {
        // Synchronously, not via the effect: a list fetch resolving in the same
        // tick would otherwise read the stale ref and drop this item again.
        detailIdRef.current = item.id;
        setItems((prev) =>
          prev.some((i) => i.id === item.id)
            ? prev.map((i) => (i.id === item.id ? item : i))
            : [...prev, item],
        );
        setDetailId(item.id);
      }),
    [basePath],
  );
  useEffect(() => {
    const itemId = searchParams.get("item");
    if (!itemId || handledDeepLinkRef.current === itemId) return;
    handledDeepLinkRef.current = itemId;

    openItemById(itemId)
      .catch((err) => {
        // 403 and 404 read the same, so a link never confirms an item exists.
        const status = err instanceof FetchError ? err.status : 0;
        setDeepLinkError(
          status === 404 || status === 403
            ? "That feedback no longer exists, or you don't have access to it."
            : "Couldn't open that feedback. Check your connection and try the link again.",
        );
      })
      .finally(() => {
        const url = new URL(window.location.href);
        url.searchParams.delete("item");
        // Keep the hash: `#c-<id>` points the thread at one comment.
        router.replace(url.pathname + url.search + url.hash);
        handledDeepLinkRef.current = null;
      });
  }, [searchParams, router, openItemById]);

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

  // The author (or an admin) edits an FR/BR's title/description. Uses jsonFetch
  // so a rejected save surfaces the API's specific reason (e.g. a 403 "Only the
  // author or an admin can edit…" or a validation message) via notifyError,
  // instead of a generic fallback — the "clear message" the ACs call for.
  async function saveEdit(item: FeedbackItem, title: string, description: string): Promise<boolean> {
    setBusyId(item.id);
    try {
      await jsonFetch(`${basePath}/${item.id}`, {
        method: "PUT",
        body: JSON.stringify({ title: title.trim(), description }),
      });
      setItems((prev) =>
        prev.map((i) =>
          i.id === item.id ? { ...i, title: title.trim(), description } : i,
        ),
      );
      return true;
    } catch (err) {
      notifyError(err, "Couldn't save the changes.");
      return false;
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
    .filter((i) => statusFilter.size === 0 || statusFilter.has(i.status))
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
          <div
            className="flex flex-wrap items-center gap-1"
            role="group"
            aria-label="Filter by status"
          >
            <span className="mr-0.5">Status</span>
            {STATUS_ORDER.map((s) => {
              const active = statusFilter.has(s);
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleStatus(s)}
                  className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                    active
                      ? "border-primary/50 bg-primary/10 text-primary"
                      : "border-[var(--border)] text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {STATUS_LABELS[s]}
                </button>
              );
            })}
            {statusFilter.size > 0 && (
              <button
                type="button"
                onClick={() => setStatusFilter(new Set())}
                className="ml-0.5 underline underline-offset-2 hover:text-foreground"
              >
                Clear
              </button>
            )}
          </div>
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
          {q !== "" ? ` matching “${search.trim()}”` : ""}
          {statusFilter.size > 0
            ? ` that are ${STATUS_ORDER.filter((s) => statusFilter.has(s))
                .map((s) => STATUS_LABELS[s].toLowerCase())
                .join(" or ")}`
            : ""}
          .
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
                      variant={item.status === "DONE" ? "progress" : item.status === "IN_REVIEW" ? "review" : "neutral"}
                      className="text-[10px]"
                    >
                      {STATUS_LABELS[item.status]}
                    </Badge>
                    {item.intake && (
                      <span title={item.intake.reason} className="inline-flex">
                        <Badge variant={INTAKE_BADGE_VARIANT[item.intake.state]} className="text-[10px]">
                          {item.intake.label}
                          {item.intake.score != null ? ` · ${item.intake.score.toFixed(2)}` : ""}
                        </Badge>
                      </span>
                    )}
                    <h3 className="font-medium text-sm truncate group-hover/fb:underline">
                      {item.title}
                    </h3>
                    {(item.commentCount ?? 0) > 0 && (
                      <span
                        className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground"
                        aria-label={`${item.commentCount} comment${item.commentCount === 1 ? "" : "s"}`}
                      >
                        <MessageSquare className="h-3 w-3" aria-hidden />
                        {item.commentCount}
                      </span>
                    )}
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

      {/* Submit dialog. Plain dismissal on purpose: backdrop press, Escape,
          Cancel and the X all close it. This once carried
          `disablePointerDismissal` to stop the Type/Project pickers taking the
          dialog down with them (COSMOS-173); that bought it by disabling
          click-outside-to-dismiss for everyone, and it was aimed at a path
          base-ui already blocks. The picker press is fixed where it went wrong,
          in <SelectContent>'s stacking — see the comment on its portal. */}
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
                // From the SERVER's policy, not a second hand-kept list: the
                // picker offering less than the route accepts is how a
                // widened upload reaches nobody.
                accept={ACCEPT_ATTRIBUTE}
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
      <FeedbackDetailDialog
        orgId={orgId}
        item={detailItem}
        canManage={canManage}
        busyId={busyId}
        onClose={() => setDetailId(null)}
        onToggleVote={(i) => void toggleVote(i)}
        onChangeStatus={(i, st) => void changeStatus(i, st)}
        onSaveEdit={saveEdit}
        onRequestDelete={setConfirmDeleteId}
        candidates={items}
        onOpenItem={(id) => void openItemById(id).catch((err) => notifyError(err, "Couldn't open that request."))}
        onMergeChanged={(item) => {
          void openItemById(item.id).catch(() => {});
          void fetchItems();
        }}
      />

      {/* A deep link that could not be opened says so, instead of silently
          leaving the reader on the board. */}
      <Dialog open={deepLinkError !== null} onOpenChange={(o) => !o && setDeepLinkError(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Couldn&apos;t open that feedback</DialogTitle>
            <DialogDescription>{deepLinkError}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeepLinkError(null)}>
              Close
            </Button>
          </DialogFooter>
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
