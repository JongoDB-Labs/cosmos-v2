"use client";

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { FileText, Upload } from "lucide-react";
import { notifyError } from "@/lib/errors/notify";
import { FileComments } from "@/components/files/file-comments";
import { FileVisibility } from "@/components/files/file-visibility";

/**
 * Everything the practice keeps, in one list.
 *
 * Two kinds of thing live here and the distinction is the point: documents that
 * belong to a job, and documents that belong to the organization — the contract
 * template, the certificate of insurance, the standard details — which had
 * nowhere to live at all while every document required a project.
 *
 * The list the server returns is already narrowed to what the reader may see,
 * so there is no client-side filtering to get wrong here.
 */

type LibraryDoc = {
  id: string;
  title: string;
  filename: string;
  format: string | null;
  status: string;
  pageCount: number | null;
  size: number;
  classificationLevel: string;
  contentType: string;
  createdAt: string;
  projectId: string | null;
  project: { key: string; name: string } | null;
  // Resolved server-side: uploadedById has no foreign key to join on, so the route
  // hydrates it in one batched lookup and sends the person, not the uuid.
  uploadedBy: { id: string; displayName: string | null; avatarUrl: string | null };
  workItemId: string | null;
  workItem: { ticketNumber: number | null; title: string } | null;
  // Resolved server-side, once per distinct project rather than per row. The
  // route enforces regardless; this only stops the list offering a control that
  // would 403.
  canManage: boolean;
  visibility: "INHERIT" | "RESTRICTED";
};

// A sentinel that cannot collide with a project key. Component state only —
// never persisted, never in a URL — so it is free to change.
const ORG = "__org__";

const fmtSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export function OrgLibrary({ orgId, canUpload }: { orgId: string; canUpload: boolean }) {
  const [scope, setScope] = useState<string>("all");
  const [term, setTerm] = useState("");
  // One expansion at a time, and the three uses are mutually exclusive: a row is
  // either showing its notes, being renamed, or being confirmed for deletion.
  const [openComments, setOpenComments] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const key = useOrgQueryKey(["org-documents"]);

  const q = useQuery({
    queryKey: key,
    queryFn: () => jsonFetch<LibraryDoc[]>(`/api/v1/orgs/${orgId}/documents`),
  });

  const rename = useMutation({
    mutationFn: async ({ id, title }: { id: string; title: string }) => {
      const res = await fetch(`/api/v1/orgs/${orgId}/documents/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw new Error((await res.text()) || "Could not rename that");
    },
    onSuccess: () => {
      setRenaming(null);
      qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => notifyError(e),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/v1/orgs/${orgId}/documents/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.text()) || "Could not delete that");
    },
    onSuccess: () => {
      setConfirmDelete(null);
      qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => notifyError(e),
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch(`/api/v1/orgs/${orgId}/documents`, { method: "POST", body });
      if (!res.ok) throw new Error((await res.text()) || "Upload failed");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  const docs = useMemo(() => q.data ?? [], [q.data]);

  // Only the projects that actually hold a file become filters — an empty
  // project in the list would be a dead end.
  const projects = useMemo(() => {
    const seen = new Map<string, string>();
    for (const d of docs) if (d.project) seen.set(d.project.key, d.project.name);
    return [...seen].sort((a, b) => a[0].localeCompare(b[0]));
  }, [docs]);

  const shown = useMemo(() => {
    const t = term.trim().toLowerCase();
    return docs.filter((d) => {
      if (scope === ORG && d.projectId) return false;
      if (scope !== "all" && scope !== ORG && d.project?.key !== scope) return false;
      if (!t) return true;
      return `${d.title} ${d.filename} ${d.project?.name ?? ""}`.toLowerCase().includes(t);
    });
  }, [docs, scope, term]);

  const orgCount = docs.filter((d) => !d.projectId).length;

  if (q.isLoading) return <Skeleton className="h-64 w-full" />;
  if (q.isError) return <LoadError onRetry={() => q.refetch()} />;

  const chip = (value: string, label: string) => (
    <button
      key={value}
      type="button"
      onClick={() => setScope(value)}
      className={cn(
        "rounded-full border px-3 py-1 text-sm",
        scope === value
          ? "border-transparent bg-[var(--primary)] text-[var(--primary-foreground)]"
          : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]",
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {chip("all", `All (${docs.length})`)}
        {chip(ORG, `Org-wide (${orgCount})`)}
        {projects.map(([k, name]) => chip(k, `${k} · ${name}`))}
        <div className="ml-auto flex items-center gap-2">
          <Input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Search files"
            className="h-9 w-56"
          />
          {canUpload && (
            <>
              <input
                ref={fileInput}
                type="file"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) upload.mutate(f);
                  e.target.value = "";
                }}
              />
              <Button
                size="sm"
                onClick={() => fileInput.current?.click()}
                disabled={upload.isPending}
              >
                <Upload className="mr-2 h-4 w-4" />
                {upload.isPending ? "Uploading…" : "Add to org files"}
              </Button>
            </>
          )}
        </div>
      </div>

      {upload.isError && (
        <p className="text-sm text-red-500">{(upload.error as Error).message}</p>
      )}

      {shown.length === 0 ? (
        <EmptyState
          illustration={
            <FileText className="mx-auto h-12 w-12 text-[var(--text-muted)]" strokeWidth={1.5} />
          }
          title={docs.length === 0 ? "No files yet" : "Nothing matches"}
          description={
            docs.length === 0
              ? "Files uploaded to a project appear here too, alongside anything kept for the practice as a whole."
              : "No file matches this filter."
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead className="border-b border-[var(--border)] text-left text-[var(--text-muted)]">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Belongs to</th>
                <th className="px-4 py-2 font-medium">Kind</th>
                <th className="px-4 py-2 text-right font-medium">Size</th>
                <th className="px-4 py-2 font-medium">Added by</th>
                <th className="px-4 py-2 font-medium">Added</th>
                <th className="px-4 py-2 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => (
                <tr key={d.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-2">
                    <a
                      href={`/api/v1/orgs/${orgId}/documents/${d.id}/original`}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      {d.title || d.filename}
                    </a>
                    {d.pageCount ? (
                      <span className="ml-2 text-xs text-[var(--text-muted)]">
                        {d.pageCount} pages
                      </span>
                    ) : null}
                    {d.visibility === "RESTRICTED" ? (
                      <span
                        className="ml-2 rounded border border-[var(--border)] px-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]"
                        title="Only the people chosen by whoever uploaded it, and org administrators"
                      >
                        Restricted
                      </span>
                    ) : null}
                    {d.status === "FAILED" ? (
                      <span className="ml-2 text-xs text-[var(--status-blocked-text,var(--text-muted))]">
                        stored, could not be read
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 text-[var(--text-muted)]">
                    {d.project ? `${d.project.key} · ${d.project.name}` : "Org-wide"}
                    {/* An attachment is filed on its project AND on the ticket it
                        was attached to, so say both: finding the file is half the
                        job, knowing what it was attached to is the other half. */}
                    {d.workItem ? (
                      <span className="ml-2 text-xs">
                        {d.workItem.ticketNumber ? `#${d.workItem.ticketNumber}` : "attached"}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 uppercase text-[var(--text-muted)]">
                    {/* `format` is only set for the few types we can read. Most
                        files now have none, so fall back to the extension —
                        otherwise this column reads "—" for nearly everything. */}
                    {d.format ?? d.filename.split(".").pop()?.toLowerCase() ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtSize(d.size)}</td>
                  <td className="px-4 py-2 text-[var(--text-muted)]">
                    {/* `displayName` can be empty for an account that has one but
                        has not set it, so `||` and not `??`. */}
                    {d.uploadedBy?.displayName || "Former member"}
                  </td>
                  <td className="px-4 py-2 tabular-nums text-[var(--text-muted)]">
                    {fmtDate(d.createdAt)}
                  </td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    <button
                      type="button"
                      className="text-xs underline text-[var(--text-muted)] hover:text-[var(--text)]"
                      onClick={() => setOpenComments(openComments === d.id ? null : d.id)}
                    >
                      {openComments === d.id ? "Hide notes" : "Notes"}
                    </button>
                    {d.canManage ? (
                      <>
                        <button
                          type="button"
                          className="ml-3 text-xs underline text-[var(--text-muted)] hover:text-[var(--text)]"
                          onClick={() => {
                            setRenaming(d.id);
                            setRenameTo(d.title || d.filename);
                          }}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          className="ml-3 text-xs underline text-[var(--text-muted)] hover:text-[var(--text)]"
                          onClick={() => setConfirmDelete(d.id)}
                        >
                          Delete
                        </button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
              {/* A second row per file rather than a drawer: the notes belong
                  under the file they are about, and a list of ten files with one
                  thread open should not hide the other nine. */}
              {shown
                .filter((d) => d.id === openComments || d.id === renaming || d.id === confirmDelete)
                .map((d) => (
                  <tr key={`${d.id}-panel`} className="border-b border-[var(--border)] last:border-0">
                    <td colSpan={7} className="bg-[var(--surface-sunk,var(--surface))] px-4 py-3">
                      {renaming === d.id ? (
                        <form
                          className="flex items-center gap-2"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const next = renameTo.trim();
                            if (next) rename.mutate({ id: d.id, title: next });
                          }}
                        >
                          <label htmlFor={`rename-${d.id}`} className="text-xs text-[var(--text-muted)]">
                            Rename
                          </label>
                          <input
                            id={`rename-${d.id}`}
                            value={renameTo}
                            onChange={(e) => setRenameTo(e.target.value)}
                            className="flex-1 rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm"
                          />
                          {/* The stored filename never changes: it decides how the
                              file is served, so a rename must not be able to move
                              it between serving tiers. */}
                          <span className="text-xs text-[var(--text-muted)]">
                            file stays {d.filename}
                          </span>
                          <Button type="submit" size="sm" disabled={rename.isPending}>
                            Save
                          </Button>
                          <Button type="button" size="sm" variant="ghost" onClick={() => setRenaming(null)}>
                            Cancel
                          </Button>
                        </form>
                      ) : confirmDelete === d.id ? (
                        <div className="flex items-center gap-3 text-sm">
                          <span>
                            Delete <b>{d.title || d.filename}</b>? This removes the file itself,
                            not just the listing.
                          </span>
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            disabled={remove.isPending}
                            onClick={() => remove.mutate(d.id)}
                          >
                            Delete
                          </Button>
                          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                            Keep it
                          </Button>
                        </div>
                      ) : (
                        <div className="space-y-4">
                          {d.canManage ? (
                            <FileVisibility
                              orgId={orgId}
                              docId={d.id}
                              visibility={d.visibility}
                            />
                          ) : null}
                          <FileComments orgId={orgId} docId={d.id} />
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
