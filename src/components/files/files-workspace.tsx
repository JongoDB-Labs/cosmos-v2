"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { FileText, Upload, Search, Trash2, FileSearch, Loader2, ExternalLink, Plus, Link2, Sparkles, X, Check, Rows3, ChevronDown, Flag, Target, Goal, Repeat, Map as MapIcon, type LucideIcon } from "lucide-react";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { ActionMenu, type ActionMenuGroup } from "@/components/ui/action-menu";
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

interface LinkRow {
  id: string;
  blockId: string;
  itemType: string;
  itemId: string;
  item: { id: string; title: string; ticketNumber?: number } | null;
}

interface Proposal {
  type: string;
  title: string;
  sourceAnchor: string | null;
}

type ConvertItemType = "ISSUE" | "MILESTONE" | "OBJECTIVE" | "GOAL" | "INTERVAL" | "ROADMAP_NODE";

interface ConvertResult {
  itemType: ConvertItemType;
  id: string;
  title: string;
  ticketNumber: number | null;
}

// The convert kinds a block can become — drives the per-block type picker and toasts.
const CONVERT_TYPES: { value: ConvertItemType; label: string; noun: string; icon: LucideIcon }[] = [
  { value: "ISSUE", label: "Issue", noun: "issue", icon: Plus },
  { value: "MILESTONE", label: "Milestone", noun: "milestone", icon: Flag },
  { value: "OBJECTIVE", label: "Objective (OKR)", noun: "objective", icon: Target },
  { value: "GOAL", label: "Goal", noun: "goal", icon: Goal },
  { value: "INTERVAL", label: "Sprint", noun: "sprint", icon: Repeat },
  { value: "ROADMAP_NODE", label: "Roadmap node", noun: "roadmap node", icon: MapIcon },
];

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

  const linksKey = useOrgQueryKey("document-links", projectId, selectedId ?? "none");
  const { data: links } = useQuery({
    queryKey: linksKey,
    queryFn: () =>
      jsonFetch<LinkRow[]>(`${apiBase}/documents/${selectedId}/links`),
    enabled: !!selectedId,
  });
  const linkByBlock = useMemo(
    () => new Map((links ?? []).map((l) => [l.blockId, l])),
    [links],
  );

  const convertMutation = useOrgMutation<
    ConvertResult,
    Error,
    { blockId: string; title?: string; itemType?: ConvertItemType }
  >({
    mutationFn: ({ blockId, title, itemType }) =>
      jsonFetch(`${apiBase}/documents/${selectedId}/convert`, {
        method: "POST",
        body: JSON.stringify({ blockId, title, itemType }),
      }),
    invalidate: [
      ["document-links", projectId, selectedId ?? "none"],
      ["work-items", projectId],
      ["milestones", projectId],
      ["objectives", projectId],
      ["goals", projectId],
      ["intervals", projectId],
      ["roadmap-nodes", projectId],
    ],
    onSuccess: (res) =>
      toast.success(
        res.itemType === "ISSUE"
          ? `Created issue #${res.ticketNumber}`
          : `Created ${CONVERT_TYPES.find((t) => t.value === res.itemType)?.noun ?? "item"} "${res.title}"`,
      ),
    onError: (e) => notifyError(e, "Couldn't create the item."),
  });

  const anchorToBlockId = useMemo(
    () => new Map((doc?.blocks ?? []).map((b) => [b.anchor, b.id])),
    [doc],
  );
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const proposeMutation = useOrgMutation<{ proposals: Proposal[] }, Error, void>({
    mutationFn: () =>
      jsonFetch(`${apiBase}/documents/${selectedId}/propose`, { method: "POST" }),
    invalidate: [],
    onSuccess: (res) => {
      setProposals(res.proposals);
      if (!res.proposals.length) toast.message("No items proposed for this document.");
    },
    onError: (e) => notifyError(e, "AI-propose failed (the org may have no model configured)."),
  });

  function acceptProposal(p: Proposal) {
    const blockId = p.sourceAnchor ? anchorToBlockId.get(p.sourceAnchor) : undefined;
    if (!blockId) {
      notifyError(new Error("No source block"), "This proposal has no source block to link.");
      return;
    }
    convertMutation.mutate({
      blockId,
      title: p.title,
      itemType: p.type === "MILESTONE" ? "MILESTONE" : "ISSUE",
    });
    setProposals((prev) => (prev ? prev.filter((x) => x !== p) : prev));
  }

  // Table → rows mapping (CSV-style): one Issue per data row, by a chosen column.
  const [tableModal, setTableModal] = useState<DocBlock | null>(null);
  const [tableHeader, setTableHeader] = useState(true);
  const [tableTitleCol, setTableTitleCol] = useState(0);
  const tableRows = ((tableModal?.data as { rows?: string[][] } | undefined)?.rows ?? []) as string[][];
  const tableCols = tableRows[0] ?? [];
  const tablePreviewCount = (tableHeader ? tableRows.slice(1) : tableRows).filter(
    (r) => (r[tableTitleCol] ?? "").trim(),
  ).length;
  const tableConvertMutation = useOrgMutation<
    { count: number },
    Error,
    { blockId: string; titleColumn: number; headerRow: boolean }
  >({
    mutationFn: ({ blockId, titleColumn, headerRow }) =>
      jsonFetch(`${apiBase}/documents/${selectedId}/convert`, {
        method: "POST",
        body: JSON.stringify({ blockId, table: { titleColumn, headerRow } }),
      }),
    invalidate: [["document-links", projectId, selectedId ?? "none"], ["work-items", projectId]],
    onSuccess: (res) => {
      toast.success(`Created ${res.count} issue${res.count === 1 ? "" : "s"}`);
      setTableModal(null);
    },
    onError: (e) => notifyError(e, "Couldn't map the table."),
  });

  function openTableModal(b: DocBlock) {
    setTableModal(b);
    setTableHeader(true);
    setTableTitleCol(0);
  }

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

  // Right-click / ⋯ actions for a document in the left list. Open navigates to
  // the reader; Delete confirms first (the list has no undo). Matches the
  // note/meeting list pattern so every list item exposes the same CRUD affordance.
  const docActions = useCallback(
    (d: DocListItem): ActionMenuGroup[] => [
      {
        items: [
          {
            label: "Open",
            icon: FileText,
            onClick: () => router.push(`${base}/${d.id}`, { scroll: false }),
          },
        ],
      },
      {
        items: [
          {
            label: "Delete",
            icon: Trash2,
            variant: "destructive",
            onClick: () => {
              if (window.confirm(`Delete "${d.title}"? This can't be undone.`)) {
                deleteMutation.mutate(d.id);
              }
            },
          },
        ],
      },
    ],
    [router, base, deleteMutation],
  );

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
                // Wrapper carries `group/action relative` so the ActionMenu's
                // hidden ⋯ trigger (a sibling, revealed on hover) positions over
                // the row; ActionMenu itself uses display:contents. Right-click
                // anywhere on the row opens the same menu.
                <div key={d.id} className="group/action relative">
                  <ActionMenu groups={docActions(d)} triggerLabel={`Actions for ${d.title}`} triggerClassName="absolute right-1 top-1.5">
                    <button
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
                  </ActionMenu>
                </div>
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
                {doc.status === "READY" && !viewOriginal && (
                  <button
                    onClick={() => proposeMutation.mutate()}
                    disabled={proposeMutation.isPending}
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)] disabled:opacity-60"
                    title="Suggest project items from this document (AI)"
                  >
                    {proposeMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    AI-propose
                  </button>
                )}
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
                {proposals && proposals.length > 0 && (
                  <div className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--surface)]/40 p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="flex items-center gap-1.5 text-sm font-medium text-[var(--text)]">
                        <Sparkles className="h-4 w-4 text-[var(--primary)]" />
                        {proposals.length} proposed item{proposals.length === 1 ? "" : "s"}
                      </span>
                      <button
                        onClick={() => setProposals(null)}
                        className="text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
                      >
                        Dismiss all
                      </button>
                    </div>
                    <div className="space-y-1.5">
                      {proposals.map((p, i) => (
                        <div
                          key={i}
                          className="flex items-center gap-2 rounded border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm"
                        >
                          <span className="shrink-0 rounded bg-[var(--primary)]/10 px-1.5 py-0.5 text-[10px] font-medium uppercase text-[var(--primary)]">
                            {p.type}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[var(--text)]">{p.title}</span>
                          {p.sourceAnchor && (
                            <a
                              href={`#${p.sourceAnchor}`}
                              className="shrink-0 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
                            >
                              source
                            </a>
                          )}
                          <button
                            onClick={() => acceptProposal(p)}
                            disabled={!p.sourceAnchor || convertMutation.isPending}
                            className="inline-flex shrink-0 items-center gap-1 rounded border border-[var(--border)] px-1.5 py-0.5 text-xs text-[var(--text)] hover:bg-[var(--surface)] disabled:opacity-50"
                            title={p.sourceAnchor ? "Create a linked issue" : "No source block to link"}
                          >
                            <Check className="h-3 w-3" /> Accept
                          </button>
                          <button
                            onClick={() =>
                              setProposals((prev) => (prev ? prev.filter((x) => x !== p) : prev))
                            }
                            className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text)]"
                            title="Skip"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
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
                    {visibleBlocks.map((b) => {
                      const linked = linkByBlock.get(b.id);
                      return (
                        <div key={b.id} className="group relative -mr-2 rounded pr-2 hover:bg-[var(--surface)]/40">
                          <FilesBlock block={b} />
                          {b.kind !== "PAGE_BREAK" && (
                            <div className="absolute right-1 top-1 flex items-center gap-1">
                              {b.kind === "TABLE" && (
                                <button
                                  type="button"
                                  onClick={() => openTableModal(b)}
                                  className="inline-flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 text-xs text-[var(--text-muted)] opacity-0 transition-opacity hover:text-[var(--text)] group-hover:opacity-100"
                                  title="Create one issue per row (map a column to the title)"
                                >
                                  <Rows3 className="h-3 w-3" /> Map rows
                                </button>
                              )}
                              {linked ? (
                                <span
                                  className="inline-flex items-center gap-1 rounded bg-[var(--primary)]/10 px-1.5 py-0.5 text-xs font-medium text-[var(--primary)]"
                                  title={linked.item?.title ?? "Linked item"}
                                >
                                  <Link2 className="h-3 w-3" />
                                  {linked.item?.ticketNumber ? `#${linked.item.ticketNumber}` : "linked"}
                                </span>
                              ) : (
                                <DropdownMenu>
                                  <DropdownMenuTrigger
                                    disabled={convertMutation.isPending}
                                    className="inline-flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--bg)] px-1.5 py-0.5 text-xs text-[var(--text-muted)] opacity-0 transition-opacity hover:text-[var(--text)] group-hover:opacity-100 data-[popup-open]:opacity-100 disabled:opacity-50"
                                    title="Create a project item from this section"
                                  >
                                    <Plus className="h-3 w-3" /> Add
                                    <ChevronDown className="h-3 w-3" />
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="w-auto min-w-[200px]">
                                    {CONVERT_TYPES.map((t) => {
                                      const Icon = t.icon;
                                      return (
                                        <DropdownMenuItem
                                          key={t.value}
                                          onClick={() =>
                                            convertMutation.mutate({ blockId: b.id, itemType: t.value })
                                          }
                                        >
                                          <Icon className="h-4 w-4" /> {t.label}
                                        </DropdownMenuItem>
                                      );
                                    })}
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </main>

      <Dialog open={tableModal !== null} onOpenChange={(o) => { if (!o) setTableModal(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Map table rows to issues</DialogTitle>
            <DialogDescription>
              Create one issue per row. Pick the column to use as the issue title; the
              remaining columns become each issue&apos;s description.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <label className="flex items-center gap-2 text-[var(--text)]">
              <input
                type="checkbox"
                checked={tableHeader}
                onChange={(e) => setTableHeader(e.target.checked)}
              />
              First row is a header
            </label>
            <div className="space-y-1">
              <span className="text-[var(--text-muted)]">Title column</span>
              <select
                value={tableTitleCol}
                onChange={(e) => setTableTitleCol(Number(e.target.value))}
                className="w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm text-[var(--text)]"
              >
                {tableCols.map((c, i) => (
                  <option key={i} value={i}>
                    {tableHeader ? c || `Column ${i + 1}` : `Column ${i + 1}`}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-xs text-[var(--text-muted)]">
              Will create {tablePreviewCount} issue{tablePreviewCount === 1 ? "" : "s"}.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTableModal(null)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                tableModal &&
                tableConvertMutation.mutate({
                  blockId: tableModal.id,
                  titleColumn: tableTitleCol,
                  headerRow: tableHeader,
                })
              }
              disabled={tableConvertMutation.isPending || tablePreviewCount === 0}
            >
              {tableConvertMutation.isPending ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : null}
              Create {tablePreviewCount} issue{tablePreviewCount === 1 ? "" : "s"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
