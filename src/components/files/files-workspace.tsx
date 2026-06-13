"use client";

import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { FileText, Upload, Search, Trash2, FileSearch, Loader2, ExternalLink } from "lucide-react";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { notifyError } from "@/lib/errors/notify";
import { toast } from "sonner";
import { FilesBlock, type DocBlock } from "./files-block";

interface DocListItem {
  id: string;
  title: string;
  filename: string;
  format: string | null;
  status: string;
  pageCount: number | null;
  size: number;
  classificationLevel: string;
  createdAt: string;
}

interface DocDetail extends DocListItem {
  blocks: DocBlock[];
}

const ACCEPT = ".docx,.pdf,.pptx,.xlsx,.xls";

interface Props {
  orgId: string;
  projectId: string;
  orgSlug: string;
  projectKey: string;
}

export function FilesWorkspace({ orgId, projectId, orgSlug, projectKey }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const base = `/${orgSlug}/projects/${projectKey}/files`;
  const apiBase = `/api/v1/orgs/${orgId}/projects/${projectId}`;
  const selectedId = pathname.startsWith(`${base}/`)
    ? decodeURIComponent(pathname.slice(base.length + 1))
    : null;

  const [query, setQuery] = useState("");
  const [viewOriginal, setViewOriginal] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const docsKey = useOrgQueryKey("documents", projectId);
  const { data: docs, isLoading } = useQuery({
    queryKey: docsKey,
    queryFn: () => jsonFetch<DocListItem[]>(`${apiBase}/documents`),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((d) => d.status === "PARSING" || d.status === "UPLOADED") ? 2000 : false,
  });

  const docKey = useOrgQueryKey("document", projectId, selectedId ?? "none");
  const { data: doc } = useQuery({
    queryKey: docKey,
    queryFn: () => jsonFetch<DocDetail>(`${apiBase}/documents/${selectedId}`),
    enabled: !!selectedId,
  });

  const uploadMutation = useOrgMutation<DocListItem, Error, File>({
    mutationFn: async (file) => {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${apiBase}/documents`, { method: "POST", body: fd });
      if (!res.ok) throw new Error(`Upload failed (HTTP ${res.status})`);
      return res.json();
    },
    invalidate: [["documents", projectId]],
    onError: (e) => notifyError(e, "Couldn't upload that file."),
  });

  const deleteMutation = useOrgMutation<{ id: string }, Error, string>({
    mutationFn: (id) => jsonFetch<{ id: string }>(`${apiBase}/documents/${id}`, { method: "DELETE" }),
    invalidate: [["documents", projectId]],
    onSuccess: (_d, id) => {
      toast.success("Document deleted");
      if (selectedId === id) router.push(base);
    },
    onError: (e) => notifyError(e, "Couldn't delete the document."),
  });

  function onPick(files: FileList | null) {
    const f = files?.[0];
    if (f) uploadMutation.mutate(f);
    if (fileInput.current) fileInput.current.value = "";
  }

  const outline = useMemo(
    () => (doc?.blocks ?? []).filter((b) => b.kind === "HEADING"),
    [doc],
  );
  const visibleBlocks = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return doc?.blocks ?? [];
    return (doc?.blocks ?? []).filter((b) => b.text.toLowerCase().includes(q));
  }, [doc, query]);

  if (isLoading) {
    return <div className="p-8 text-sm text-[var(--text-muted)]">Loading files…</div>;
  }

  return (
    <div className="flex h-full min-h-0">
      {/* ── Left rail: upload + file list + outline ── */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)]/40">
        <div className="border-b border-[var(--border)] p-3">
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={uploadMutation.isPending}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-[var(--primary)] px-3 py-1.5 text-sm font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-60"
          >
            {uploadMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            Upload
          </button>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => onPick(e.target.files)}
          />
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto p-2">
          {(docs ?? []).length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-[var(--text-muted)]">
              No documents yet. Upload docx, pdf, pptx or xlsx.
            </p>
          ) : (
            <div className="space-y-0.5">
              {(docs ?? []).map((d) => (
                <button
                  key={d.id}
                  onClick={() => router.push(`${base}/${d.id}`, { scroll: false })}
                  className={cn(
                    "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-sm",
                    selectedId === d.id ? "bg-[var(--primary)]/10" : "hover:bg-[var(--surface)]",
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                    <span className="truncate text-[var(--text)]">{d.title}</span>
                  </span>
                  <span className="flex items-center gap-1.5 pl-5 text-[10px] uppercase text-[var(--text-muted)]">
                    <span>{d.format}</span>
                    {d.status !== "READY" && <span>· {d.status.toLowerCase()}</span>}
                    {d.classificationLevel !== "UNCLASSIFIED" && (
                      <span className="font-semibold text-[var(--status-critical)]">· {d.classificationLevel}</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          )}

          {doc && outline.length > 0 && (
            <div className="mt-4">
              <p className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">Outline</p>
              {outline.map((h) => (
                <a
                  key={h.id}
                  href={`#${h.anchor}`}
                  className="block truncate rounded px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
                  style={{ paddingLeft: `${8 + (Math.min(h.level ?? 1, 4) - 1) * 10}px` }}
                >
                  {h.text}
                </a>
              ))}
            </div>
          )}
        </nav>
      </aside>

      {/* ── Main pane ── */}
      <main className="min-w-0 flex-1 overflow-y-auto">
        {!doc ? (
          <div className="mx-auto max-w-2xl px-4 py-16 text-center">
            <FileSearch className="mx-auto h-10 w-10 text-[var(--text-muted)]" />
            <h2 className="mt-4 text-lg font-semibold text-[var(--text)]">Project documents</h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-[var(--text-muted)]">
              Upload a document and it&apos;s parsed into a navigable, searchable view. Select one on
              the left to read it.
            </p>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl px-6 py-6">
            {/* header */}
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h1 className="text-xl font-semibold text-[var(--text)]">{doc.title}</h1>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                  <span className="uppercase">{doc.format}</span>
                  {doc.pageCount ? <span>· {doc.pageCount} pages</span> : null}
                  {doc.classificationLevel !== "UNCLASSIFIED" && (
                    <Badge variant="critical">{doc.classificationLevel}</Badge>
                  )}
                  {doc.status !== "READY" && <span>· {doc.status.toLowerCase()}</span>}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => setViewOriginal((v) => !v)}
                  className="rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
                >
                  {viewOriginal ? "Normalized" : "View original"}
                </button>
                <button
                  onClick={() => deleteMutation.mutate(doc.id)}
                  className="rounded-md border border-[var(--border)] p-1.5 text-[var(--text-muted)] hover:text-[var(--status-critical)]"
                  title="Delete document"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {viewOriginal ? (
              doc.format === "pdf" ? (
                <iframe
                  src={`${apiBase}/documents/${doc.id}/original`}
                  className="h-[70vh] w-full rounded border border-[var(--border)]"
                  title={doc.filename}
                />
              ) : (
                <a
                  href={`${apiBase}/documents/${doc.id}/original`}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-2 text-sm text-[var(--text)] hover:bg-[var(--surface)]"
                >
                  <ExternalLink className="h-4 w-4" /> Download original ({doc.filename})
                </a>
              )
            ) : (
              <>
                <div className="relative mb-4">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-[var(--text-muted)]" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search in document…"
                    className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] py-1.5 pl-8 pr-2 text-sm text-[var(--text)] outline-none focus:ring-2 focus:ring-[var(--primary)]/40"
                  />
                </div>
                {doc.status === "FAILED" ? (
                  <p className="text-sm text-[var(--status-critical)]">
                    Couldn&apos;t parse this document. Use &quot;View original&quot; to download it.
                  </p>
                ) : visibleBlocks.length === 0 ? (
                  <p className="text-sm text-[var(--text-muted)]">No matching content.</p>
                ) : (
                  <div className="space-y-3">
                    {visibleBlocks.map((b) => (
                      <FilesBlock key={b.id} block={b} />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
