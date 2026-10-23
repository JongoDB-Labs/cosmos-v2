"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
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

export interface FeedbackComment {
  id: string;
  parentId: string | null;
  kind: string;
  visibility: "PUBLIC" | "INTERNAL";
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
  item: { id: string; isMine?: boolean; lockedAt?: string | null; mergedIntoId?: string | null };
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

  const closed = !!item.mergedIntoId || (!!item.lockedAt && !isStaff);
  const canComment = !closed && (can(Permission.COMMENT_CREATE) || !!item.isMine);

  async function send(content: string, parentId?: string) {
    setBusy(true);
    try {
      await jsonFetch(base, { method: "POST", body: JSON.stringify({ content, ...(parentId ? { parentId } : {}) }) });
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
        actions={
          !isReply && canComment ? (
            <button
              type="button"
              className="mt-1 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => {
                setReplyTo(replyTo === c.id ? null : c.id);
                setReplyDraft("");
              }}
            >
              Reply
            </button>
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
      <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <MessageSquare className="h-3.5 w-3.5" />
        Discussion{comments.length > 0 ? ` (${countAll(comments)})` : ""}
      </h3>
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : comments.length === 0 ? (
        <p className="text-xs text-muted-foreground">No comments yet. Ask a question or add context.</p>
      ) : (
        <div className="space-y-3">{comments.map((c) => render(c, false))}</div>
      )}
      {canComment ? (
        <CommentComposer
          orgId={orgId}
          value={draft}
          resetKey={draftKey}
          onChange={setDraft}
          onSubmit={async () => {
            if (await send(draft.trim())) {
              setDraft("");
              setDraftKey((k) => k + 1);
            }
          }}
          mentionLabels={mentionLabels}
          disabled={busy}
          submitLabel="Post comment"
        />
      ) : item.mergedIntoId ? (
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
