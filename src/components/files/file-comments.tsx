"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { Button } from "@/components/ui/button";
import { notifyError } from "@/lib/errors/notify";

interface FileComment {
  id: string;
  content: string;
  createdAt: string;
  mine: boolean;
  author: { id: string; displayName: string | null; avatarUrl: string | null };
}

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });

/**
 * The conversation about one file.
 *
 * Anyone who may READ the file may write here, deliberately: this is how
 * somebody who can look at a drawing but not alter it says what is wrong with
 * it. Removing is the author's own, or whoever manages the file.
 */
export function FileComments({ orgId, docId }: { orgId: string; docId: string }) {
  const base = `/api/v1/orgs/${orgId}/documents/${docId}/comments`;
  const key = useOrgQueryKey("document-comments", docId);
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");

  const { data: comments = [], isLoading } = useQuery({
    queryKey: key,
    queryFn: () => jsonFetch<FileComment[]>(base),
    staleTime: 15_000,
  });

  const add = useMutation({
    mutationFn: async (content: string) => {
      const res = await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error((await res.text()) || "Could not post that");
    },
    onSuccess: () => {
      setDraft("");
      qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => notifyError(e),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`${base}/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: (e) => notifyError(e),
  });

  return (
    <div className="space-y-3">
      {isLoading ? (
        <p className="text-xs text-[var(--text-muted)]">Loading&hellip;</p>
      ) : comments.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">
          Nothing said about this file yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {comments.map((c) => (
            <li key={c.id} className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-2">
              <div className="flex items-baseline gap-2 text-xs text-[var(--text-muted)]">
                {/* displayName can be "" on an account that never set one. */}
                <span className="font-medium text-[var(--text)]">
                  {c.author?.displayName || "Former member"}
                </span>
                <span>{fmtWhen(c.createdAt)}</span>
                {c.mine ? (
                  <button
                    type="button"
                    aria-label="Delete this comment"
                    className="ml-auto rounded p-0.5 hover:text-[var(--text)]"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(c.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm">{c.content}</p>
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const text = draft.trim();
          if (text) add.mutate(text);
        }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Say something about this file"
          aria-label="Add a comment"
          className="flex-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm"
        />
        <Button type="submit" size="sm" disabled={!draft.trim() || add.isPending}>
          {add.isPending ? "Posting…" : "Comment"}
        </Button>
      </form>
    </div>
  );
}
