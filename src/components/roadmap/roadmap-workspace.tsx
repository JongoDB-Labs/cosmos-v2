"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import {
  Map as MapIcon,
  Search,
  ChevronRight,
  Link2,
  ArrowLeft,
} from "lucide-react";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { RoadmapMarkdown } from "./roadmap-markdown";

type RoadmapKind =
  | "SECTION"
  | "SUBPHASE"
  | "LOE"
  | "RISK"
  | "DECISION"
  | "STAKEHOLDER"
  | "MILESTONE";

interface RoadmapNode {
  id: string;
  kind: RoadmapKind;
  externalRef: string | null;
  section: string | null;
  category: string | null;
  title: string;
  body: string;
  anchor: string;
  parentId: string | null;
  sortOrder: number;
}

const KIND_BADGE: Record<RoadmapKind, { variant: BadgeVariant; label: string }> = {
  SECTION: { variant: "neutral", label: "Section" },
  SUBPHASE: { variant: "strategic", label: "Phase" },
  LOE: { variant: "discovery", label: "LOE" },
  RISK: { variant: "critical", label: "Risk" },
  DECISION: { variant: "review", label: "Decision" },
  STAKEHOLDER: { variant: "neutral", label: "Stakeholder" },
  MILESTONE: { variant: "done", label: "Milestone" },
};

interface Props {
  orgId: string;
  projectId: string;
  orgSlug: string;
  projectKey: string;
}

export function RoadmapWorkspace({ orgId, projectId, orgSlug, projectKey }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [query, setQuery] = useState("");

  const base = `/${orgSlug}/projects/${projectKey}/roadmap`;
  const selectedAnchor = pathname.startsWith(`${base}/`)
    ? decodeURIComponent(pathname.slice(base.length + 1))
    : null;

  const nodesKey = useOrgQueryKey("roadmap-nodes", projectId);
  const { data: nodes, isLoading } = useQuery({
    queryKey: nodesKey,
    queryFn: () =>
      jsonFetch<RoadmapNode[]>(`/api/v1/orgs/${orgId}/projects/${projectId}/roadmap-nodes`),
  });

  const { sections, byId, childrenOf, byAnchor } = useMemo(() => {
    const all = nodes ?? [];
    const byId = new Map<string, RoadmapNode>();
    const byAnchor = new Map<string, RoadmapNode>();
    const childrenOf = new Map<string, RoadmapNode[]>();
    for (const n of all) {
      byId.set(n.id, n);
      byAnchor.set(n.anchor, n);
    }
    for (const n of all) {
      if (n.parentId) {
        const arr = childrenOf.get(n.parentId) ?? [];
        arr.push(n);
        childrenOf.set(n.parentId, arr);
      }
    }
    for (const arr of childrenOf.values()) arr.sort((a, b) => a.sortOrder - b.sortOrder);
    const sections = all
      .filter((n) => n.kind === "SECTION")
      .sort((a, b) => a.sortOrder - b.sortOrder);
    return { sections, byId, childrenOf, byAnchor };
  }, [nodes]);

  const selected = selectedAnchor ? byAnchor.get(selectedAnchor) ?? null : null;
  // The section to highlight in the rail: the selection itself if it's a section,
  // else its parent section, else the first section.
  const activeSection: RoadmapNode | null = selected
    ? selected.kind === "SECTION"
      ? selected
      : selected.parentId
        ? byId.get(selected.parentId) ?? null
        : null
    : sections[0] ?? null;

  const go = (anchor: string) => router.push(`${base}/${anchor}`, { scroll: false });

  function copyLink(anchor: string) {
    const url =
      typeof window !== "undefined" ? `${window.location.origin}${base}/${anchor}` : `${base}/${anchor}`;
    navigator.clipboard?.writeText(url).then(
      () => toast.success("Deep link copied"),
      () => toast.error("Couldn't copy link"),
    );
  }

  const filteredNodes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return (nodes ?? [])
      .filter(
        (n) =>
          n.title.toLowerCase().includes(q) ||
          (n.externalRef ?? "").toLowerCase().includes(q) ||
          (n.category ?? "").toLowerCase().includes(q),
      )
      .slice(0, 40);
  }, [nodes, query]);

  if (isLoading) {
    return (
      <div className="p-8 text-sm text-muted-foreground">Loading roadmap…</div>
    );
  }

  if (!nodes || nodes.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center">
        <MapIcon className="mx-auto h-10 w-10 text-muted-foreground" />
        <h2 className="mt-4 text-lg font-semibold text-foreground">No roadmap yet</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          Ingest your program roadmap so issues can link to phases, risks and
          decisions as source-of-truth. Have your LLM convert your roadmap doc to
          the import format and POST it, or use the roadmap MCP server.
        </p>
        <code className="mt-4 inline-block rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
          GET /api/v1/orgs/{orgId}/projects/{projectId}/roadmap-nodes/import
        </code>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      {/* ── Left rail: sections + search ── */}
      <aside className="flex w-64 shrink-0 flex-col border-r bg-muted/20">
        <div className="border-b p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search nodes…"
              className="w-full rounded-md border bg-background py-1.5 pl-8 pr-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto p-2">
          {query.trim() ? (
            <div className="space-y-0.5">
              <p className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {filteredNodes.length} match{filteredNodes.length === 1 ? "" : "es"}
              </p>
              {filteredNodes.map((n) => (
                <button
                  key={n.id}
                  onClick={() => go(n.anchor)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                >
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {n.externalRef ?? KIND_BADGE[n.kind].label}
                  </span>
                  <span className="truncate text-foreground">{n.title}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="space-y-0.5">
              {sections.map((s) => {
                const isActive = activeSection?.id === s.id;
                const kids = childrenOf.get(s.id) ?? [];
                return (
                  <button
                    key={s.id}
                    onClick={() => go(s.anchor)}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                      isActive
                        ? "bg-primary/10 font-medium text-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <span className="truncate">{s.title}</span>
                    {kids.length > 0 && (
                      <span className="shrink-0 text-xs text-muted-foreground">{kids.length}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </nav>
      </aside>

      {/* ── Main pane ── */}
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 py-6">
          {selected && selected.kind !== "SECTION" ? (
            <NodeDetail
              node={selected}
              parent={selected.parentId ? byId.get(selected.parentId) ?? null : null}
              onBack={() =>
                activeSection ? go(activeSection.anchor) : router.push(base)
              }
              onCopyLink={() => copyLink(selected.anchor)}
            />
          ) : (
            <SectionView
              section={activeSection}
              items={activeSection ? childrenOf.get(activeSection.id) ?? [] : []}
              gotoAnchor={go}
            />
          )}
        </div>
      </main>
    </div>
  );
}

function KindBadge({ kind }: { kind: RoadmapKind }) {
  const meta = KIND_BADGE[kind];
  return <Badge variant={meta.variant}>{meta.label}</Badge>;
}

function SectionView({
  section,
  items,
  gotoAnchor,
}: {
  section: RoadmapNode | null;
  items: RoadmapNode[];
  gotoAnchor: (a: string) => void;
}) {
  if (!section) {
    return <p className="text-sm text-muted-foreground">Select a section.</p>;
  }
  return (
    <div>
      <h1 className="text-xl font-semibold text-foreground">{section.title}</h1>
      {section.body && (
        <div className="mt-4">
          <RoadmapMarkdown>{section.body}</RoadmapMarkdown>
        </div>
      )}
      {items.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {items.length} item{items.length === 1 ? "" : "s"}
          </h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {items.map((c) => (
              <button
                key={c.id}
                onClick={() => gotoAnchor(c.anchor)}
                className="group flex flex-col gap-1.5 rounded-lg border bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/40"
              >
                <div className="flex items-center justify-between gap-2">
                  <KindBadge kind={c.kind} />
                  {c.externalRef && (
                    <span className="font-mono text-xs text-muted-foreground">{c.externalRef}</span>
                  )}
                </div>
                <span className="line-clamp-2 text-sm font-medium text-foreground">{c.title}</span>
                {c.category && (
                  <span className="text-xs text-muted-foreground">{c.category}</span>
                )}
                <ChevronRight className="mt-1 h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function NodeDetail({
  node,
  parent,
  onBack,
  onCopyLink,
}: {
  node: RoadmapNode;
  parent: RoadmapNode | null;
  onBack: () => void;
  onCopyLink: () => void;
}) {
  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-2">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {parent ? parent.title : "Back"}
        </button>
        <button
          onClick={onCopyLink}
          className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Copy a deep link to paste into an issue description"
        >
          <Link2 className="h-3.5 w-3.5" />
          Copy link
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <KindBadge kind={node.kind} />
        {node.externalRef && (
          <span className="font-mono text-sm text-muted-foreground">{node.externalRef}</span>
        )}
        {node.category && (
          <span className="text-xs text-muted-foreground">· {node.category}</span>
        )}
      </div>

      <h1 className="mt-2 text-xl font-semibold text-foreground">{node.title}</h1>

      {node.body && (
        <div className="mt-4">
          <RoadmapMarkdown>{node.body}</RoadmapMarkdown>
        </div>
      )}
    </div>
  );
}
