"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Paperclip, X } from "lucide-react";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { Button } from "@/components/ui/button";
import { notifyError } from "@/lib/errors/notify";

interface Attachment {
  id: string;
  title: string;
  filename: string;
  size: number;
  status: string;
  format: string | null;
  createdAt: string;
  uploadedBy: { id: string; displayName: string | null; avatarUrl: string | null };
}

const fmtSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * Files attached to a work item.
 *
 * Each one is a document in the project's library with this item recorded on it, so
 * it is searchable under Files like anything else and this panel is a view rather
 * than a second store. Removing one here DETACHES it: the file stays in the project
 * library, because a wrong attachment and an unwanted file are different mistakes
 * and only the second should destroy bytes.
 */
export function WorkItemAttachments({
  itemId,
  orgId,
  projectId,
  canAttach,
}: {
  itemId: string;
  orgId: string;
  projectId: string;
  canAttach: boolean;
}) {
  const base = `/api/v1/orgs/${orgId}/projects/${projectId}/work-items/${itemId}/attachments`;
  const key = useOrgQueryKey("work-item-attachments", projectId, itemId);
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const { data: files = [] } = useQuery({
    queryKey: key,
    queryFn: () => jsonFetch<Attachment[]>(base),
    staleTime: 30_000,
  });

  const detach = useMutation({
    mutationFn: async (docId: string) => {
      const res = await fetch(`${base}/${docId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await res.text());
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key });
      // The file is still in the project library, so that list changed too.
      qc.invalidateQueries({ queryKey: ["org-documents"] });
    },
    onError: (e) => notifyError(e),
  });

  async function upload(list: FileList | null) {
    if (!list?.length) return;
    setBusy(true);
    try {
      for (const file of Array.from(list)) {
        const body = new FormData();
        body.append("file", file);
        const res = await fetch(base, { method: "POST", body });
        if (!res.ok) throw new Error((await res.text()) || `Could not attach ${file.name}`);
      }
      qc.invalidateQueries({ queryKey: key });
      qc.invalidateQueries({ queryKey: ["org-documents"] });
    } catch (e) {
      notifyError(e);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  // Nothing attached and no right to attach: say nothing rather than show an empty
  // affordance somebody cannot use.
  if (files.length === 0 && !canAttach) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)]">
          <Paperclip className="h-3.5 w-3.5" />
          Attachments{files.length ? ` (${files.length})` : ""}
        </span>
        {canAttach ? (
          <>
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => upload(e.target.files)}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              {busy ? "Attaching…" : "Attach a file"}
            </Button>
          </>
        ) : null}
      </div>

      {files.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">
          Nothing attached. Anything you attach is also filed under this project&rsquo;s files.
        </p>
      ) : (
        <ul className="space-y-1">
          {files.map((f) => (
            <li
              key={f.id}
              className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-xs"
            >
              <a
                href={`/api/v1/orgs/${orgId}/documents/${f.id}/original`}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate underline"
                title={f.filename}
              >
                {f.title || f.filename}
              </a>
              <span className="shrink-0 tabular-nums text-[var(--text-muted)]">
                {fmtSize(f.size)}
              </span>
              {/* Who and when, on the row. `displayName` can be an empty string on an
                  account that has never set one, so `||` and not `??`. */}
              <span className="shrink-0 text-[var(--text-muted)]">
                {f.uploadedBy?.displayName || "Former member"} &middot; {fmtWhen(f.createdAt)}
              </span>
              {canAttach ? (
                <button
                  type="button"
                  aria-label={`Remove ${f.filename} from this item`}
                  title="Remove from this item (the file stays in the project's files)"
                  className="shrink-0 rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text)]"
                  disabled={detach.isPending}
                  onClick={() => detach.mutate(f.id)}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
