"use client";

import { useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQueries } from "@tanstack/react-query";
import { GitFork, AlertTriangle, Ban, Zap } from "lucide-react";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { bareTypeKey } from "@/components/boards/shared/filter-bar";
import { cn } from "@/lib/utils";
import type { WorkItem } from "@/types/models";

interface DependencyMapProps {
  orgId: string;
  projectId: string;
  projectKey: string;
}

interface WorkItemLink {
  id: string;
  type: "BLOCKS" | "BLOCKED_BY" | "RELATES" | "DUPLICATES" | "PREDECESSOR" | "SUCCESSOR";
  sourceItemId: string;
  targetItemId: string;
  sourceTicketNumber: number;
  targetTicketNumber: number;
}

const typeColorMap: Record<string, string> = {
  EPIC: "#8b5cf6",
  STORY: "#3b82f6",
  TASK: "#22c55e",
  BUG: "#ef4444",
  SUBTASK: "#6b7280",
};

const NODE_W = 190;
const NODE_H = 46;
const COL_GAP = 96;
const ROW_GAP = 18;
const PAD = 24;

/** Directed dependency edges only (a "must come before" relation). RELATES /
 *  DUPLICATES are soft — drawn faintly, never used for layering. Returns the
 *  normalized `from → to` where `to` DEPENDS ON `from`. */
function directedEdge(l: WorkItemLink): { from: string; to: string } | null {
  switch (l.type) {
    case "BLOCKS":
    case "PREDECESSOR":
      return { from: l.sourceItemId, to: l.targetItemId };
    case "BLOCKED_BY":
    case "SUCCESSOR":
      return { from: l.targetItemId, to: l.sourceItemId };
    default:
      return null; // RELATES / DUPLICATES
  }
}

/**
 * Project Dependency Map (FR a36d8f16). Lays the dependency graph out as a
 * left→right layered DAG — each item sits one column right of its deepest
 * predecessor — with blocked / blocker / cycle summaries. Reuses the same
 * longest-chain DP the Gantt uses for the critical path. Clicking a node opens
 * that item via the canonical /issues?item deep-link.
 */
export function DependencyMap({ orgId, projectId, projectKey }: DependencyMapProps) {
  const router = useRouter();
  const params = useParams<{ orgSlug: string }>();
  const orgSlug = params.orgSlug;
  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}`;

  const itemsKey = useOrgQueryKey("work-items", projectId);
  const linksKey = useOrgQueryKey("work-item-links", projectId);

  const [itemsQ, linksQ] = useQueries({
    queries: [
      { queryKey: itemsKey, queryFn: () => jsonFetch<WorkItem[]>(`${basePath}/work-items`) },
      { queryKey: linksKey, queryFn: () => jsonFetch<WorkItemLink[]>(`${basePath}/work-item-links`) },
    ],
  });

  const items = useMemo(() => itemsQ.data ?? [], [itemsQ.data]);
  const links = useMemo(() => linksQ.data ?? [], [linksQ.data]);
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const graph = useMemo(() => {
    // Only links whose BOTH ends are live items participate.
    const directed = links
      .map(directedEdge)
      .filter((e): e is { from: string; to: string } => !!e && itemById.has(e.from) && itemById.has(e.to));
    const soft = links.filter(
      (l) => (l.type === "RELATES" || l.type === "DUPLICATES") && itemById.has(l.sourceItemId) && itemById.has(l.targetItemId),
    );

    const preds = new Map<string, string[]>(); // to → [from]
    const succs = new Map<string, string[]>(); // from → [to]
    const push = (m: Map<string, string[]>, k: string, v: string) => {
      const arr = m.get(k);
      if (arr) arr.push(v);
      else m.set(k, [v]);
    };
    for (const e of directed) {
      push(preds, e.to, e.from);
      push(succs, e.from, e.to);
    }

    // Nodes that touch ANY dependency (directed or soft) — the map only plots
    // items that are actually connected, so it stays legible.
    const connected = new Set<string>();
    for (const e of directed) {
      connected.add(e.from);
      connected.add(e.to);
    }
    for (const l of soft) {
      connected.add(l.sourceItemId);
      connected.add(l.targetItemId);
    }

    // Cycle detection (DFS over directed edges) — flags edges that close a loop
    // so the layout can't wedge and the user sees the problem.
    const cycleNodes = new Set<string>();
    const color = new Map<string, 0 | 1 | 2>(); // 0 unseen, 1 in-stack, 2 done
    const dfs = (id: string) => {
      color.set(id, 1);
      for (const nxt of succs.get(id) ?? []) {
        const c = color.get(nxt) ?? 0;
        if (c === 1) {
          cycleNodes.add(id);
          cycleNodes.add(nxt);
        } else if (c === 0) dfs(nxt);
      }
      color.set(id, 2);
    };
    for (const id of connected) if ((color.get(id) ?? 0) === 0) dfs(id);

    // Layer = longest predecessor chain (cycle-guarded), like the Gantt's DP.
    const layerMemo = new Map<string, number>();
    const visiting = new Set<string>();
    const layerOf = (id: string): number => {
      const c = layerMemo.get(id);
      if (c !== undefined) return c;
      if (visiting.has(id)) return 0; // cycle guard
      visiting.add(id);
      let best = 0;
      for (const p of preds.get(id) ?? []) best = Math.max(best, layerOf(p) + 1);
      visiting.delete(id);
      layerMemo.set(id, best);
      return best;
    };

    const layers: string[][] = [];
    for (const id of connected) {
      const L = layerOf(id);
      (layers[L] ??= []).push(id);
    }
    // Stable order within a layer: by ticket number.
    for (const col of layers) {
      col?.sort((a, b) => (itemById.get(a)?.ticketNumber ?? 0) - (itemById.get(b)?.ticketNumber ?? 0));
    }

    // Positions.
    const pos = new Map<string, { x: number; y: number }>();
    layers.forEach((col, layer) => {
      (col ?? []).forEach((id, row) => {
        pos.set(id, {
          x: PAD + layer * (NODE_W + COL_GAP),
          y: PAD + row * (NODE_H + ROW_GAP),
        });
      });
    });

    const width =
      PAD * 2 + Math.max(1, layers.length) * NODE_W + Math.max(0, layers.length - 1) * COL_GAP;
    const tallest = Math.max(1, ...layers.map((c) => c?.length ?? 0));
    const height = PAD * 2 + tallest * NODE_H + (tallest - 1) * ROW_GAP;

    const blockedCount = preds.size; // items depending on ≥1 other
    const blockerCount = succs.size; // items others depend on

    return {
      directed,
      soft,
      pos,
      width,
      height,
      cycleNodes,
      connectedCount: connected.size,
      blockedCount,
      blockerCount,
    };
  }, [links, itemById]);

  const loading = itemsQ.isLoading || linksQ.isLoading;

  if (loading) {
    return (
      <div className="p-6">
        <Skeleton className="mb-4 h-16 w-full max-w-2xl" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (graph.connectedCount === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={GitFork}
          title="No dependencies yet"
          description="Link work items with Blocks / Predecessor / Relates from a ticket's detail panel, and the dependency map will plot them here."
        />
      </div>
    );
  }

  const drawNode = (id: string) => {
    const p = graph.pos.get(id);
    const item = itemById.get(id);
    if (!p || !item) return null;
    const color = typeColorMap[bareTypeKey(item.workItemType?.key)] ?? typeColorMap.TASK;
    const inCycle = graph.cycleNodes.has(id);
    const label = item.title.length > 24 ? item.title.slice(0, 23) + "…" : item.title;
    return (
      <g
        key={id}
        transform={`translate(${p.x}, ${p.y})`}
        className="cursor-pointer"
        onClick={() => router.push(`/${orgSlug}/issues?item=${id}`)}
      >
        <rect
          width={NODE_W}
          height={NODE_H}
          rx={8}
          className="fill-[var(--surface)]"
          stroke={inCycle ? "var(--status-critical)" : "var(--border)"}
          strokeWidth={inCycle ? 2 : 1}
        />
        <rect width={4} height={NODE_H} rx={2} fill={color} />
        <text x={14} y={19} className="fill-[var(--text-muted)] text-[10px]" style={{ fontSize: 10 }}>
          {projectKey}-{item.ticketNumber}
        </text>
        <text x={14} y={34} className="fill-[var(--text)] text-xs font-medium" style={{ fontSize: 12 }}>
          {label}
        </text>
        {inCycle && (
          <text x={NODE_W - 16} y={19} style={{ fontSize: 11 }} fill="var(--status-critical)">
            ⟳
          </text>
        )}
      </g>
    );
  };

  const edgePath = (fromId: string, toId: string) => {
    const a = graph.pos.get(fromId);
    const b = graph.pos.get(toId);
    if (!a || !b) return null;
    const x1 = a.x + NODE_W;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;
    const midX = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
  };

  return (
    <div className="flex h-full flex-col">
      {/* Summary bar */}
      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] px-4 py-2.5 text-sm">
        <div className="flex items-center gap-2 font-medium text-[var(--text)]">
          <GitFork className="size-4 text-[var(--primary)]" /> Dependency Map
        </div>
        <Stat icon={<GitFork className="size-3.5" />} label="dependencies" value={graph.directed.length + graph.soft.length} />
        <Stat icon={<Ban className="size-3.5 text-amber-500" />} label="blocked" value={graph.blockedCount} />
        <Stat icon={<Zap className="size-3.5 text-blue-500" />} label="blockers" value={graph.blockerCount} />
        {graph.cycleNodes.size > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-[var(--status-critical)]/10 px-2 py-0.5 text-xs font-medium text-[var(--status-critical)]">
            <AlertTriangle className="size-3.5" /> {graph.cycleNodes.size} in a cycle
          </span>
        )}
      </div>

      {/* Graph */}
      <div className="flex-1 overflow-auto p-2">
        <svg data-testid="dep-graph" width={graph.width} height={graph.height} className="block">
          <defs>
            <marker id="dep-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="fill-[var(--text-muted)]" />
            </marker>
          </defs>

          {/* soft (relates/duplicates) — dashed, under everything */}
          {graph.soft.map((l) => {
            const d = edgePath(l.sourceItemId, l.targetItemId);
            return d ? (
              <path key={l.id} d={d} className="stroke-[var(--border)]" strokeWidth={1} strokeDasharray="4 3" fill="none" />
            ) : null;
          })}
          {/* directed dependency edges */}
          {graph.directed.map((e, i) => {
            const d = edgePath(e.from, e.to);
            const crit = graph.cycleNodes.has(e.from) && graph.cycleNodes.has(e.to);
            return d ? (
              <path
                key={i}
                d={d}
                stroke={crit ? "var(--status-critical)" : "var(--text-muted)"}
                strokeOpacity={crit ? 0.9 : 0.5}
                strokeWidth={crit ? 2 : 1.5}
                fill="none"
                markerEnd="url(#dep-arrow)"
              />
            ) : null;
          })}
          {/* nodes */}
          {[...graph.pos.keys()].map(drawNode)}
        </svg>
      </div>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs text-[var(--text-muted)]")}>
      {icon}
      <span className="font-semibold text-[var(--text)]">{value}</span> {label}
    </span>
  );
}
