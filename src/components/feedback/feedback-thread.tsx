"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, MessageSquare, Pin } from "lucide-react";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useRealtimeEvents } from "@/hooks/use-realtime-events";
import { notifyError } from "@/lib/errors/notify";
import { useOrgMembers } from "@/components/chat/mention-typeahead";
import { useRefResolver } from "@/components/mentions/hooks";
import { refKey, type ResolvedEntity } from "@/lib/mentions/refs";
import { usePermissions, Permission } from "@/components/providers/permissions-provider";
import { Button } from "@/components/ui/button";
import { LocalTimestamp } from "@/components/ui/local-timestamp";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CommentItem } from "@/components/comments/comment-item";
import { CommentComposer } from "@/components/comments/comment-composer";
import {
  CLASSIFICATION_BADGE_COLORS,
  classificationLabel,
  type ClassificationLevel,
} from "@/lib/classification/levels";
import { COMMENT_MARKINGS, markingAllowed, markingForcesInternal } from "@/lib/feedback/marking";

export interface FeedbackComment {
  id: string;
  parentId: string | null;
  kind: string;
  visibility: "PUBLIC" | "INTERNAL";
  classification: ClassificationLevel | null;
  content: string | null;
  deleted: boolean;
  author: { id: string; displayName: string | null; avatarUrl: string | null } | null;
  createdAt: string;
  editedAt: string | null;
  revisionCount: number;
  canEdit: boolean;
  canDelete: boolean;
  replies: FeedbackComment[];
}

interface Revision {
  id: string;
  content: string | null;
  redacted: boolean;
  editedBy: { displayName: string | null };
  createdAt: string;
}

const countAll = (list: FeedbackComment[]) =>
  list.reduce((n, c) => n + (c.deleted ? 0 : 1) + c.replies.length, 0);

type Audience = "PUBLIC" | "INTERNAL";
type ShowFilter = "all" | "public" | "internal";
const TAB_KEY = "cosmos:feedback-composer-tab";

export const RAISE_MARKING_CONFIRM =
  "Mark this comment at a level the whole organization isn't cleared for? It and every reply under it become " +
  "internal at once, it stops being the official response, and the notifications that quote them are taken back. " +
  "Push alerts already delivered can't be recalled.";

export const MAKE_INTERNAL_CONFIRM =
  "Make this comment internal? From now on only the feedback team will see it, and the notifications " +
  "that quote it are taken back from everyone else. Push alerts already delivered can't be recalled.";

/** The staff composer's last tab, remembered per browser as a convenience. */
function readTab(): Audience {
  try {
    return window.localStorage.getItem(TAB_KEY) === "INTERNAL" ? "INTERNAL" : "PUBLIC";
  } catch {
    return "PUBLIC";
  }
}
function writeTab(tab: Audience) {
  try {
    window.localStorage.setItem(TAB_KEY, tab);
  } catch {
    /* a convenience only */
  }
}

/** The official response first, the rest in order. */
const pinned = (list: FeedbackComment[]) =>
  [...list].sort((a, b) => Number(b.kind === "OFFICIAL") - Number(a.kind === "OFFICIAL"));

function keep(list: FeedbackComment[], show: ShowFilter): FeedbackComment[] {
  if (show === "all") return list;
  const want: Audience = show === "public" ? "PUBLIC" : "INTERNAL";
  return list
    .map((c) => ({ ...c, replies: c.replies.filter((r) => r.visibility === want) }))
    .filter((c) => c.visibility === want || c.replies.length > 0);
}

/**
 * The discussion on one feedback item ("chat about a given bug fix or feature
 * request"): comments with one level of replies, @mentions, edit history and
 * tombstones. Live: another person's comment appears without a refresh.
 */
export function FeedbackThread({
  orgId,
  item,
}: {
  orgId: string;
  item: { id: string; status?: string; isMine?: boolean; lockedAt?: string | null; mergedIntoId?: string | null };
}) {
  const base = `/api/v1/orgs/${orgId}/feedback/${item.id}/comments`;
  const key = useOrgQueryKey("feedback-comments", item.id);
  const qc = useQueryClient();
  const { can } = usePermissions();
  const isStaff = can(Permission.ORG_UPDATE);

  const { data: comments = [], isLoading } = useQuery({
    queryKey: key,
    queryFn: () => jsonFetch<FeedbackComment[]>(base),
    staleTime: 15_000,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: key });

  // Staff on a gov tenant can mark what they post; null everywhere else.
  const policyKey = useOrgQueryKey("feedback-comment-policy");
  const { data: policy } = useQuery({
    queryKey: policyKey,
    queryFn: () =>
      jsonFetch<{ marking: { orgCeiling: ClassificationLevel } | null }>(
        `/api/v1/orgs/${orgId}/feedback/comment-policy`,
      ),
    enabled: isStaff,
    staleTime: 5 * 60_000,
  });
  const markingPolicy = isStaff ? (policy?.marking ?? null) : null;
  // Above CUI, only what the org's own ceiling covers may be stored at all.
  const markings = markingPolicy
    ? COMMENT_MARKINGS.filter((l) => markingAllowed(l.value, markingPolicy.orgCeiling))
    : [];

  // Someone else's comment arrives without a refresh. Events carry ids only;
  // the refetch goes through the permission-checked GET.
  const mine = (d: unknown) => (d as { feedbackId?: string })?.feedbackId === item.id;
  useRealtimeEvents(orgId, {
    "feedback.comment.created": (d) => mine(d) && refresh(),
    "feedback.comment.updated": (d) => mine(d) && refresh(),
    "feedback.comment.deleted": (d) => mine(d) && refresh(),
  });

  // Person chips resolve from the member map; other entities via the resolver.
  const { data: members } = useOrgMembers(orgId);
  const seed = useMemo(() => {
    const m = new Map<string, ResolvedEntity>();
    for (const u of members ?? []) m.set(refKey("user", u.id), { type: "user", id: u.id, label: u.displayName, url: null });
    return m;
  }, [members]);
  const contents = useMemo(
    () => comments.flatMap((c) => [c.content ?? "", ...c.replies.map((r) => r.content ?? "")]),
    [comments],
  );
  const refMap = useRefResolver(orgId, contents, seed);
  const mentionLabels = useMemo(() => new Map([...refMap].map(([k, v]) => [k, v.label])), [refMap]);

  // `#c-<id>` (from a notification) scrolls to that comment and marks it.
  const [highlight, setHighlight] = useState<string | null>(null);
  useEffect(() => {
    if (isLoading) return;
    const m = /^#c-([0-9a-f-]+)$/i.exec(window.location.hash);
    if (!m) return;
    const el = document.getElementById(`c-${m[1]}`);
    if (!el) return;
    el.scrollIntoView?.({ block: "center" });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHighlight(m[1]);
  }, [isLoading, comments]);

  const [draft, setDraft] = useState("");
  const [draftKey, setDraftKey] = useState(0);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  // Staff only: which audience the composer posts to, and which comments show.
  const [tab, setTab] = useState<Audience>("PUBLIC");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isStaff) setTab(readTab());
  }, [isStaff]);
  const [asOfficial, setAsOfficial] = useState(false);
  const [marking, setMarking] = useState<ClassificationLevel | "">("");
  const [show, setShow] = useState<ShowFilter>("all");
  // A marking above what the whole org may read keeps the post internal.
  const markedInternal = !!marking && !!markingPolicy && markingForcesInternal(marking, markingPolicy.orgCeiling);
  const internal = isStaff && (tab === "INTERNAL" || markedInternal);

  // MERGED counts without a pointer too: deleting the survivor nulls it, and
  // the server still refuses comments then.
  const merged = !!item.mergedIntoId || item.status === "MERGED";
  const closed = merged || (!!item.lockedAt && !isStaff);
  const canComment = !closed && (can(Permission.COMMENT_CREATE) || !!item.isMine);

  async function send(
    content: string,
    parentId?: string,
    opts: { visibility?: Audience; official?: boolean; classification?: ClassificationLevel } = {},
  ) {
    setBusy(true);
    try {
      await jsonFetch(base, {
        method: "POST",
        body: JSON.stringify({
          content,
          ...(parentId ? { parentId } : {}),
          ...(opts.visibility === "INTERNAL" ? { visibility: "INTERNAL" } : {}),
          ...(opts.official ? { kind: "OFFICIAL" } : {}),
          ...(opts.classification ? { classification: opts.classification } : {}),
        }),
      });
      refresh();
      return true;
    } catch (err) {
      notifyError(err, "Couldn't post your comment.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(id: string, content: string) {
    try {
      await jsonFetch(`${base}/${id}`, { method: "PATCH", body: JSON.stringify({ content }) });
      refresh();
      return true;
    } catch (err) {
      notifyError(err, "Couldn't save the edit.");
      return false;
    }
  }

  async function moderate(
    id: string,
    change: { visibility: Audience } | { official: boolean } | { classification: ClassificationLevel | null },
    failure: string,
  ) {
    try {
      await jsonFetch(`${base}/${id}`, { method: "PATCH", body: JSON.stringify(change) });
      refresh();
    } catch (err) {
      notifyError(err, failure);
    }
  }

  async function remove(id: string) {
    try {
      await jsonFetch(`${base}/${id}`, { method: "DELETE" });
      refresh();
    } catch (err) {
      notifyError(err, "Couldn't delete the comment.");
    }
  }

  const render = (c: FeedbackComment, isReply: boolean) =>
    c.deleted ? (
      <div key={c.id} id={`c-${c.id}`} className="space-y-3">
        <p className="text-xs italic text-muted-foreground">This comment was deleted.</p>
        {c.replies.length > 0 && <div className="space-y-3 border-l pl-3">{c.replies.map((r) => render(r, true))}</div>}
      </div>
    ) : (
      <CommentItem
        key={c.id}
        id={c.id}
        authorName={c.author?.displayName ?? "Former member"}
        createdAt={c.createdAt}
        edited={!!c.editedAt}
        editedLabel={
          <>
            {" · "}
            <button
              type="button"
              className="underline-offset-2 hover:underline"
              onClick={() => setHistoryFor(c.id)}
              aria-label="Edit history"
            >
              edited
            </button>
          </>
        }
        content={c.content ?? ""}
        refMap={refMap}
        orgId={orgId}
        mentionLabels={mentionLabels}
        canEdit={c.canEdit}
        canDelete={c.canDelete}
        onSave={(content) => save(c.id, content)}
        onDelete={() => void remove(c.id)}
        highlighted={highlight === c.id}
        badge={
          <>
            {c.classification && (
              <span
                className={`rounded px-1.5 text-[10px] font-semibold ${CLASSIFICATION_BADGE_COLORS[c.classification]}`}
                aria-label={`Marked ${classificationLabel(c.classification)}`}
              >
                {classificationLabel(c.classification).toUpperCase()}
              </span>
            )}
            {c.kind === "OFFICIAL" ? (
              <span className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 text-[10px] font-medium text-primary">
                <Pin className="h-2.5 w-2.5" aria-hidden />
                Official response
              </span>
            ) : c.visibility === "INTERNAL" ? (
              <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                <Lock className="h-2.5 w-2.5" aria-hidden />
                Internal
              </span>
            ) : null}
          </>
        }
        actions={
          (!isReply && canComment) || isStaff ? (
            <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
              {!isReply && canComment && (
                <button
                  type="button"
                  className="hover:text-foreground"
                  onClick={() => {
                    setReplyTo(replyTo === c.id ? null : c.id);
                    setReplyDraft("");
                  }}
                >
                  Reply
                </button>
              )}
              {isStaff && !isReply && c.visibility === "PUBLIC" && (
                <button
                  type="button"
                  className="hover:text-foreground"
                  title={c.kind === "OFFICIAL" ? "Unpin to let its author edit it again" : undefined}
                  onClick={() =>
                    void moderate(c.id, { official: c.kind !== "OFFICIAL" }, "Couldn't change the official response.")
                  }
                >
                  {c.kind === "OFFICIAL" ? "Unpin official response" : "Mark as official response"}
                </button>
              )}
              {isStaff && c.kind !== "OFFICIAL" && (
                <button
                  type="button"
                  className="hover:text-foreground"
                  onClick={() => {
                    const toInternal = c.visibility !== "INTERNAL";
                    if (toInternal && !window.confirm(MAKE_INTERNAL_CONFIRM)) return;
                    void moderate(
                      c.id,
                      { visibility: toInternal ? "INTERNAL" : "PUBLIC" },
                      "Couldn't change who can see this comment.",
                    );
                  }}
                >
                  {c.visibility === "INTERNAL" ? "Make public" : "Make internal"}
                </button>
              )}
              {markingPolicy && (
                <select
                  aria-label="Change marking"
                  value={c.classification ?? ""}
                  onChange={(e) => {
                    const next = (e.target.value || null) as ClassificationLevel | null;
                    const raises =
                      !!next && c.visibility === "PUBLIC" && markingForcesInternal(next, markingPolicy.orgCeiling);
                    if (raises && !window.confirm(RAISE_MARKING_CONFIRM)) return;
                    void moderate(c.id, { classification: next }, "Couldn't change the marking.");
                  }}
                  className="rounded border bg-background px-1 text-[11px]"
                >
                  <option value="">No marking</option>
                  {c.classification && !markings.some((l) => l.value === c.classification) && (
                    <option value={c.classification}>{classificationLabel(c.classification)}</option>
                  )}
                  {markings.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ) : null
        }
      >
        {!isReply && (c.replies.length > 0 || replyTo === c.id) && (
          <div className="mt-2 space-y-3 border-l pl-3">
            {c.replies.map((r) => render(r, true))}
            {replyTo === c.id && (
              <CommentComposer
                orgId={orgId}
                value={replyDraft}
                resetKey={`reply-${c.id}`}
                onChange={setReplyDraft}
                onSubmit={async () => {
                  if (await send(replyDraft.trim(), c.id)) setReplyTo(null);
                }}
                mentionLabels={mentionLabels}
                disabled={busy}
                placeholder="Write a reply…"
                ariaLabel="Reply"
                submitLabel="Post reply"
              />
            )}
          </div>
        )}
      </CommentItem>
    );

  return (
    <section aria-label="Discussion" className="space-y-3 border-t pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <MessageSquare className="h-3.5 w-3.5" />
          Discussion{comments.length > 0 ? ` (${countAll(comments)})` : ""}
        </h3>
        {isStaff && (
          <div role="group" aria-label="Show comments" className="flex gap-1 text-[11px]">
            {(["all", "public", "internal"] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={show === f}
                className={`rounded px-1.5 ${show === f ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => setShow(f)}
              >
                {f === "all" ? "All" : f === "public" ? "Public" : "Internal"}
              </button>
            ))}
          </div>
        )}
      </div>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : comments.length === 0 ? (
        <p className="text-xs text-muted-foreground">No comments yet. Ask a question or add context.</p>
      ) : (
        <div className="space-y-3">{pinned(keep(comments, show)).map((c) => render(c, false))}</div>
      )}
      {canComment ? (
        <div className={internal ? "space-y-2 rounded-lg bg-amber-500/10 p-2" : "space-y-2"}>
          {isStaff && (
            <div className="flex flex-wrap items-center gap-3">
              <div role="tablist" aria-label="Post as" className="flex gap-1 text-xs">
                {(["PUBLIC", "INTERNAL"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    aria-selected={tab === t}
                    className={`rounded-md px-2 py-0.5 ${tab === t ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    onClick={() => {
                      setTab(t);
                      writeTab(t);
                    }}
                  >
                    {t === "PUBLIC" ? "Comment" : "Internal note"}
                  </button>
                ))}
              </div>
              {markingPolicy && (
                <select
                  aria-label="Marking"
                  value={marking}
                  onChange={(e) => setMarking(e.target.value as ClassificationLevel | "")}
                  className="rounded-md border bg-background px-1.5 py-0.5 text-[11px]"
                >
                  <option value="">No marking</option>
                  {markings.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </select>
              )}
              {internal ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400">
                  <Lock className="h-3 w-3" aria-hidden />
                  {markedInternal && tab !== "INTERNAL"
                    ? `Marked ${classificationLabel(marking as ClassificationLevel)}: only the feedback team will see this`
                    : "Only the feedback team will see this"}
                </span>
              ) : (
                <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <input type="checkbox" checked={asOfficial} onChange={(e) => setAsOfficial(e.target.checked)} />
                  Post as the official response
                </label>
              )}
            </div>
          )}
          <CommentComposer
            orgId={orgId}
            value={draft}
            resetKey={draftKey}
            onChange={setDraft}
            onSubmit={async () => {
              const opts = {
                ...(internal ? { visibility: "INTERNAL" as const } : { official: isStaff && asOfficial }),
                ...(markingPolicy && marking ? { classification: marking } : {}),
              };
              if (await send(draft.trim(), undefined, opts)) {
                setDraft("");
                setDraftKey((k) => k + 1);
                setAsOfficial(false);
                setMarking("");
              }
            }}
            mentionLabels={mentionLabels}
            disabled={busy}
            placeholder={internal ? "Write an internal note… (@ to mention)" : undefined}
            ariaLabel={internal ? "Internal note" : "Comment"}
            submitLabel={internal ? "Post internal note" : "Post comment"}
          />
        </div>
      ) : merged ? (
        <p className="text-xs text-muted-foreground">This request was merged; the discussion continues there.</p>
      ) : item.lockedAt ? (
        <p className="text-xs text-muted-foreground">Comments are closed on this request.</p>
      ) : null}

      <RevisionHistory base={base} commentId={historyFor} onClose={() => setHistoryFor(null)} />
    </section>
  );
}

function RevisionHistory({ base, commentId, onClose }: { base: string; commentId: string | null; onClose: () => void }) {
  const key = useOrgQueryKey("feedback-comment-revisions", commentId);
  const { data: revisions = [] } = useQuery({
    queryKey: key,
    queryFn: () => jsonFetch<Revision[]>(`${base}/${commentId}/revisions`),
    enabled: commentId !== null,
  });
  return (
    <Dialog open={commentId !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit history</DialogTitle>
          <DialogDescription>What this comment said before each edit, newest first.</DialogDescription>
        </DialogHeader>
        <ol className="max-h-80 space-y-3 overflow-y-auto">
          {revisions.map((r) => (
            <li key={r.id} className="space-y-1 text-sm">
              <div className="text-[11px] text-muted-foreground">
                {r.editedBy.displayName ?? "Former member"} · <LocalTimestamp value={r.createdAt} />
              </div>
              <p className="whitespace-pre-wrap">{r.redacted ? <em>Redacted</em> : r.content}</p>
            </li>
          ))}
        </ol>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogContent>
    </Dialog>
  );
}
