"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQueries } from "@tanstack/react-query";
import { GitFork, AlertTriangle, Ban, Zap, X, ExternalLink } from "lucide-react";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { bareTypeKey } from "@/components/boards/shared/filter-bar";
import { cn } from "@/lib/utils";
import type { WorkItem } from "@/types/models";

/** The up+downstream dependency chain of a node — itself + everything it
 *  (transitively) depends on + everything that (transitively) depends on it. */
function computeChain(
  id: string,
  preds: Map<string, string[]>,
  succs: Map<string, string[]>,
): Set<string> {
  const chain = new Set<string>([id]);
  const walk = (adj: Map<string, string[]>) => {
    const stack = [id];
    while (stack.length) {
      const n = stack.pop()!;
      for (const m of adj.get(n) ?? []) {
        if (!chain.has(m)) {
          chain.add(m);
          stack.push(m);
        }
      }
    }
  };
  walk(preds);
  walk(succs);
  return chain;
}

/** Dependency STATE color for a node — done / overdue / open, from the fields a
 *  work item always carries (no board columns needed here). */
function statusColor(item: WorkItem): { color: string; label: string } {
  if (item.completedAt) return { color: "#22c55e", label: "Done" };
  if (item.dueDate && new Date(item.dueDate) < new Date()) return { color: "#ef4444", label: "Overdue" };
  return { color: "#f59e0b", label: "Open" };
}

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
  const params = useParams<{ orgSlug: string }>();
  const orgSlug = params.orgSlug;
  const basePath = `/api/v1/orgs/${orgId}/projects/${projectId}`;
  // Focused node: clicking a node selects it (highlights its chain + opens the
  // dependency panel) instead of navigating away (FR 5dab88f8).
  const [selected, setSelected] = useState<string | null>(null);

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

    // Soft (relates/duplicates) adjacency, undirected, for the detail panel.
    const softAdj = new Map<string, Set<string>>();
    const linkSoft = (a: string, b: string) => {
      let set = softAdj.get(a);
      if (!set) {
        set = new Set<string>();
        softAdj.set(a, set);
      }
      set.add(b);
    };
    for (const l of soft) {
      linkSoft(l.sourceItemId, l.targetItemId);
      linkSoft(l.targetItemId, l.sourceItemId);
    }

    return {
      directed,
      soft,
      pos,
      width,
      height,
      cycleNodes,
      preds,
      succs,
      softAdj,
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

  const chainSet = selected ? computeChain(selected, graph.preds, graph.succs) : null;

  const drawNode = (id: string) => {
    const p = graph.pos.get(id);
    const item = itemById.get(id);
    if (!p || !item) return null;
    const color = typeColorMap[bareTypeKey(item.workItemType?.key)] ?? typeColorMap.TASK;
    const inInterval = graph.cycleNodes.has(id);
    const status = statusColor(item);
    const isSelected = selected === id;
    // When a node is focused, fade everything outside its chain.
    const dimmed = chainSet ? !chainSet.has(id) : false;
    const label = item.title.length > 24 ? item.title.slice(0, 23) + "…" : item.title;
    return (
      <g
        key={id}
        transform={`translate(${p.x}, ${p.y})`}
        className="cursor-pointer"
        opacity={dimmed ? 0.28 : 1}
        onClick={() => setSelected(id)}
      >
        <rect
          width={NODE_W}
          height={NODE_H}
          rx={8}
          className="fill-[var(--surface)]"
          stroke={isSelected ? "var(--primary)" : inInterval ? "var(--status-critical)" : "var(--border)"}
          strokeWidth={isSelected || inInterval ? 2 : 1}
        />
        <rect width={4} height={NODE_H} rx={2} fill={color} />
        <text x={14} y={19} className="fill-[var(--text-muted)] text-[10px]" style={{ fontSize: 10 }}>
          {projectKey}-{item.ticketNumber}
        </text>
        <text x={14} y={34} className="fill-[var(--text)] text-xs font-medium" style={{ fontSize: 12 }}>
          {label}
        </text>
        {/* Dependency-state dot (done / overdue / open). */}
        <circle cx={NODE_W - 12} cy={12} r={4} fill={status.color}>
          <title>{status.label}</title>
        </circle>
        {inInterval && (
          <text x={NODE_W - 26} y={NODE_H - 8} style={{ fontSize: 11 }} fill="var(--status-critical)">
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

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[var(--border)] px-4 py-1.5 text-[11px] text-[var(--text-muted)]">
        <span className="flex items-center gap-1">
          <svg width="26" height="8"><line x1="0" y1="4" x2="20" y2="4" stroke="var(--text-muted)" strokeWidth="1.5" markerEnd="url(#dep-arrow)" /></svg>
          depends on →
        </span>
        <span className="flex items-center gap-1">
          <svg width="26" height="8"><line x1="0" y1="4" x2="24" y2="4" stroke="var(--border)" strokeWidth="1" strokeDasharray="4 3" /></svg>
          related
        </span>
        <span className="flex items-center gap-1"><span className="inline-block size-2 rounded-full" style={{ background: "#22c55e" }} /> done</span>
        <span className="flex items-center gap-1"><span className="inline-block size-2 rounded-full" style={{ background: "#f59e0b" }} /> open</span>
        <span className="flex items-center gap-1"><span className="inline-block size-2 rounded-full" style={{ background: "#ef4444" }} /> overdue</span>
        <span className="flex items-center gap-1 text-[var(--status-critical)]">⟳ cycle</span>
        <span className="ml-auto">Click a node to trace its chain</span>
      </div>

      {/* Graph + detail panel */}
      <div className="relative flex-1 overflow-hidden">
      <div className="h-full overflow-auto p-2">
        <svg data-testid="dep-graph" width={graph.width} height={graph.height} className="block">
          <defs>
            <marker id="dep-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="fill-[var(--text-muted)]" />
            </marker>
          </defs>

          {/* soft (relates/duplicates) — dashed, under everything */}
          {graph.soft.map((l) => {
            const d = edgePath(l.sourceItemId, l.targetItemId);
            const dim = chainSet ? !(chainSet.has(l.sourceItemId) && chainSet.has(l.targetItemId)) : false;
            return d ? (
              <path
                key={l.id}
                d={d}
                className="stroke-[var(--border)]"
                strokeWidth={1}
                strokeDasharray="4 3"
                fill="none"
                opacity={dim ? 0.2 : 1}
              />
            ) : null;
          })}
          {/* directed dependency edges */}
          {graph.directed.map((e, i) => {
            const d = edgePath(e.from, e.to);
            const crit = graph.cycleNodes.has(e.from) && graph.cycleNodes.has(e.to);
            const onChain = chainSet ? chainSet.has(e.from) && chainSet.has(e.to) : false;
            const dim = chainSet ? !onChain : false;
            return d ? (
              <path
                key={i}
                d={d}
                stroke={crit ? "var(--status-critical)" : onChain ? "var(--primary)" : "var(--text-muted)"}
                strokeOpacity={dim ? 0.18 : crit || onChain ? 0.9 : 0.5}
                strokeWidth={crit || onChain ? 2 : 1.5}
                fill="none"
                markerEnd="url(#dep-arrow)"
              />
            ) : null;
          })}
          {/* nodes */}
          {[...graph.pos.keys()].map(drawNode)}
        </svg>
      </div>

      {/* In-place dependency panel for the focused node. */}
      {selected && itemById.get(selected) && (
        <div className="absolute right-0 top-0 flex h-full w-80 flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-xl">
          {(() => {
            const item = itemById.get(selected)!;
            const st = statusColor(item);
            const toItems = (ids: Iterable<string>) =>
              [...new Set(ids)].map((id) => itemById.get(id)).filter((x): x is WorkItem => !!x);
            const dependsOn = toItems(graph.preds.get(selected) ?? []);
            const blocks = toItems(graph.succs.get(selected) ?? []);
            const related = toItems(graph.softAdj.get(selected) ?? []);
            return (
              <>
                <div className="flex items-start justify-between gap-2 border-b border-[var(--border)] px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                      <span className="font-mono">{projectKey}-{item.ticketNumber}</span>
                      <span className="inline-flex items-center gap-1">
                        <span className="inline-block size-2 rounded-full" style={{ background: st.color }} /> {st.label}
                      </span>
                    </div>
                    <p className="mt-0.5 text-sm font-medium text-[var(--text)]">{item.title}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelected(null)}
                    aria-label="Close"
                    className="shrink-0 rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--border)]"
                  >
                    <X className="size-4" />
                  </button>
                </div>
                <div className="flex-1 space-y-4 overflow-y-auto px-3 py-3 text-sm">
                  <DepList title="Depends on" hint="must finish first" items={dependsOn} projectKey={projectKey} onPick={setSelected} />
                  <DepList title="Blocks" hint="waiting on this" items={blocks} projectKey={projectKey} onPick={setSelected} />
                  <DepList title="Related" hint="soft link" items={related} projectKey={projectKey} onPick={setSelected} />
                </div>
                <div className="border-t border-[var(--border)] px-3 py-2">
                  <Link
                    href={`/${orgSlug}/issues?item=${selected}`}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--primary)] hover:underline"
                  >
                    <ExternalLink className="size-3.5" /> Open full ticket
                  </Link>
                </div>
              </>
            );
          })()}
        </div>
      )}
      </div>
    </div>
  );
}

function DepList({
  title,
  hint,
  items,
  projectKey,
  onPick,
}: {
  title: string;
  hint: string;
  items: WorkItem[];
  projectKey: string;
  onPick: (id: string) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">{title}</span>
        <span className="text-[10px] text-[var(--text-muted)]">· {hint}</span>
        <span className="ml-auto text-[10px] text-[var(--text-muted)]">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">None</p>
      ) : (
        <ul className="space-y-1">
          {items.map((i) => {
            const st = statusColor(i);
            return (
              <li key={i.id}>
                <button
                  type="button"
                  onClick={() => onPick(i.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-[var(--border)]/40"
                >
                  <span className="inline-block size-2 shrink-0 rounded-full" style={{ background: st.color }} title={st.label} />
                  <span className="shrink-0 font-mono text-[11px] text-[var(--text-muted)]">{projectKey}-{i.ticketNumber}</span>
                  <span className="truncate text-xs text-[var(--text)]">{i.title}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
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
