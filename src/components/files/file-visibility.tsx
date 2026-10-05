"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { Button } from "@/components/ui/button";
import { notifyError } from "@/lib/errors/notify";
import { useOrgMembers } from "@/components/chat/mention-typeahead";

interface Share {
  id: string;
  createdAt: string;
  user: { id: string; displayName: string | null; avatarUrl: string | null };
  grantedBy: { id: string; displayName: string | null; avatarUrl: string | null };
}

/**
 * Who can see one file.
 *
 * Two states, and the copy has to be honest about both. INHERIT is not "public"
 * — it is "as visible as the job this sits on", which for a team-scoped project
 * is already quite narrow. RESTRICTED is not "secret" — org administrators can
 * still see it, and saying so here is the difference between a setting and a
 * promise that is not kept.
 */
export function FileVisibility({
  orgId,
  docId,
  visibility,
}: {
  orgId: string;
  docId: string;
  visibility: "INHERIT" | "RESTRICTED";
}) {
  const docUrl = `/api/v1/orgs/${orgId}/documents/${docId}`;
  const sharesKey = useOrgQueryKey("document-shares", docId);
  const listKey = useOrgQueryKey(["org-documents"]);
  const qc = useQueryClient();
  const [adding, setAdding] = useState("");
  // useOrgMembers returns a query, and its rows are already normalised to
  // { id, displayName, email, avatarUrl }.
  const { data: members = [] } = useOrgMembers(orgId);

  const restricted = visibility === "RESTRICTED";

  const { data: shares = [] } = useQuery({
    queryKey: sharesKey,
    queryFn: () => jsonFetch<Share[]>(`${docUrl}/shares`),
    enabled: restricted,
    staleTime: 15_000,
  });

  const setMode = useMutation({
    mutationFn: async (next: "INHERIT" | "RESTRICTED") => {
      const res = await fetch(docUrl, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ visibility: next }),
      });
      if (!res.ok) throw new Error((await res.text()) || "Could not change that");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey }),
    onError: (e) => notifyError(e),
  });

  const share = useMutation({
    mutationFn: async (userId: string) => {
      const res = await fetch(`${docUrl}/shares`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      if (!res.ok) throw new Error((await res.text()) || "Could not share it");
    },
    onSuccess: () => {
      setAdding("");
      qc.invalidateQueries({ queryKey: sharesKey });
    },
    onError: (e) => notifyError(e),
  });

  const unshare = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`${docUrl}/shares/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: sharesKey }),
    onError: (e) => notifyError(e),
  });

  const already = new Set(shares.map((s) => s.user.id));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-xs font-medium text-[var(--text-muted)]">Who can see this</span>
        <Button
          type="button"
          size="sm"
          variant={restricted ? "ghost" : "secondary"}
          disabled={setMode.isPending}
          onClick={() => setMode.mutate("INHERIT")}
        >
          Everyone on the job
        </Button>
        <Button
          type="button"
          size="sm"
          variant={restricted ? "secondary" : "ghost"}
          disabled={setMode.isPending}
          onClick={() => setMode.mutate("RESTRICTED")}
        >
          Only people I choose
        </Button>
      </div>

      <p className="text-xs text-[var(--text-muted)]">
        {restricted
          ? "Hidden from the rest of the project. Org administrators can still see it."
          : "As visible as the job it is filed on — which for a team-scoped project is already limited to that team."}
      </p>

      {restricted ? (
        <div className="space-y-2">
          {shares.length > 0 ? (
            <ul className="space-y-1">
              {shares.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs"
                >
                  <span className="flex-1 truncate">
                    {s.user?.displayName || "Former member"}
                  </span>
                  <span className="text-[var(--text-muted)]">
                    shared by {s.grantedBy?.displayName || "Former member"}
                  </span>
                  <button
                    type="button"
                    aria-label={`Stop sharing with ${s.user?.displayName || "this person"}`}
                    className="rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text)]"
                    disabled={unshare.isPending}
                    onClick={() => unshare.mutate(s.id)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-[var(--text-muted)]">
              Nobody else yet — only you and the administrators.
            </p>
          )}

          <div className="flex gap-2">
            <select
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
              aria-label="Share with"
              className="flex-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm"
            >
              <option value="">Share with&hellip;</option>
              {members
                .filter((m) => !already.has(m.id))
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName || m.id}
                  </option>
                ))}
            </select>
            <Button
              type="button"
              size="sm"
              disabled={!adding || share.isPending}
              onClick={() => share.mutate(adding)}
            >
              Share
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
