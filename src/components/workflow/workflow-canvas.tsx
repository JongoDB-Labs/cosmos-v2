"use client";

import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { LayoutGrid } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isPlainTransition, setGlobal, setMove } from "@/lib/workflow/draft-edit";
import type { VersionLayout, WorkflowDefinition } from "@/lib/workflow/definition";
import { ANY_NODE, BAND_ORDER, layoutWorkflow } from "./layered-layout";

interface StatusInfo {
  key: string;
  name: string;
  color: string;
  category: string;
}

type StatusNodeData = { label: string; color: string; category: string; initial: boolean };

const CATEGORY_LABEL: Record<string, string> = { TODO: "To do", IN_PROGRESS: "In progress", DONE: "Done", CANCELLED: "Cancelled" };

function StatusNode({ data }: NodeProps<Node<StatusNodeData>>) {
  return (
    <div
      className="rounded-md border-2 bg-background px-3 py-2 text-sm shadow-sm"
      style={{ borderColor: data.color, width: 160 }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="font-medium leading-tight">{data.label}</div>
      <div className="text-[11px] text-muted-foreground">
        {CATEGORY_LABEL[data.category] ?? data.category}
        {data.initial && " · start"}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function AnyNode() {
  return (
    <div className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-dashed bg-background text-xs text-muted-foreground" title="From any status">
      ◎ any
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const NODE_TYPES = { status: StatusNode, any: AnyNode };

/**
 * The canvas view of the draft: statuses as nodes in category bands,
 * transitions as labelled edges, moves from any status drawn once from an
 * "◎ any" node. Drag from a node's right handle to another node to allow that
 * move; select an edge and press Delete to remove it; click an edge to open
 * its transition. Positions are kept with the draft (`layout.nodes`); the
 * first open, and "Auto-layout", place them in bands (layered-layout.ts).
 *
 * A second view of the same draft: the matrix is the accessible one.
 */
export function WorkflowCanvas({
  definition,
  statuses,
  layout,
  onChange,
  onLayoutChange,
  onEditTransition,
  readOnly = false,
}: {
  definition: WorkflowDefinition;
  statuses: StatusInfo[];
  layout: VersionLayout;
  onChange: (next: WorkflowDefinition) => void;
  onLayoutChange: (nodes: NonNullable<VersionLayout["nodes"]>) => void;
  onEditTransition: (id: string) => void;
  readOnly?: boolean;
}) {
  const byKey = useMemo(() => new Map(statuses.map((s) => [s.key, s])), [statuses]);
  const nameOf = useCallback((key: string) => byKey.get(key)?.name ?? key, [byKey]);
  const hasGlobal = definition.transitions.some((t) => t.from === "*");

  const edges: Edge[] = useMemo(
    () =>
      definition.transitions.flatMap((t) =>
        (t.from === "*" ? [ANY_NODE] : t.from)
          .filter((src) => src !== t.to)
          .map((src) => ({
            id: `${t.id}:${src}`,
            source: src,
            target: t.to,
            label: t.name,
            data: { transitionId: t.id },
            markerEnd: { type: MarkerType.ArrowClosed },
            animated: !isPlainTransition(t),
            style: t.hidden ? { strokeDasharray: "4 4" } : undefined,
          })),
      ),
    [definition.transitions],
  );

  const ids = useMemo(() => [...(hasGlobal ? [ANY_NODE] : []), ...definition.statuses.map((s) => s.key)], [hasGlobal, definition.statuses]);
  const stored = layout.nodes ?? {};
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>(stored);
  const missing = ids.some((id) => !positions[id]);

  const runLayout = useCallback(
    () =>
      layoutWorkflow(
        ids.map((id) => ({ id, category: id === ANY_NODE ? null : (byKey.get(id)?.category ?? null) })),
        edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
      ),
    [ids, byKey, edges],
  );
  const autoLayout = () =>
    void runLayout().then((next) => {
      setPositions(next);
      onLayoutChange(next);
    });

  // First open (or a status added since): lay out what has no place yet.
  useEffect(() => {
    if (!missing) return;
    let alive = true;
    void runLayout().then((next) => {
      if (!alive) return;
      setPositions(next);
      onLayoutChange(next);
    });
    return () => {
      alive = false;
    };
    // Only when something lacks a place; onLayoutChange is the editor's setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missing, runLayout]);

  const nodes: Node[] = ids.map((id) =>
    id === ANY_NODE
      ? { id, type: "any", position: positions[id] ?? { x: 0, y: 0 }, data: {} }
      : {
          id,
          type: "status",
          position: positions[id] ?? { x: 0, y: 0 },
          data: {
            label: nameOf(id),
            color: byKey.get(id)?.color ?? "#94a3b8",
            category: byKey.get(id)?.category ?? "TODO",
            initial: !!definition.statuses.find((s) => s.key === id)?.isInitial,
          } satisfies StatusNodeData,
        },
  );

  const onConnect = (c: Connection) => {
    if (readOnly || !c.source || !c.target || c.target === ANY_NODE) return;
    onChange(c.source === ANY_NODE ? setGlobal(definition, c.target, true, nameOf) : setMove(definition, c.source, c.target, true, nameOf));
  };

  const onEdgesDelete = (deleted: Edge[]) => {
    if (readOnly) return;
    let next = definition;
    for (const e of deleted) {
      next = e.source === ANY_NODE ? setGlobal(next, e.target, false) : setMove(next, e.source, e.target, false);
    }
    onChange(next);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>Bands, left to right: {BAND_ORDER.map((b) => CATEGORY_LABEL[b]).join(" · ")}.</span>
        <span>Drag from a status&apos;s right edge to another to allow the move; select a line and press Delete to remove it.</span>
        <Button className="ml-auto" variant="outline" size="sm" onClick={autoLayout}>
          <LayoutGrid className="mr-1 h-3.5 w-3.5" aria-hidden />
          Auto-layout
        </Button>
      </div>
      <div className="h-[560px] rounded-md border" aria-label="Workflow diagram. The transitions table holds the same moves and is keyboard accessible." role="region">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onConnect={onConnect}
          onEdgesDelete={onEdgesDelete}
          onEdgeClick={(_, e) => onEditTransition((e.data as { transitionId: string }).transitionId)}
          onNodeDragStop={(_, n) => {
            const next = { ...positions, [n.id]: n.position };
            setPositions(next);
            onLayoutChange(next);
          }}
          onNodesChange={(changes) => {
            // Positions are ours: follow drags live without a store.
            const moved = changes.flatMap((c) => (c.type === "position" && c.position ? [[c.id, c.position] as const] : []));
            if (moved.length > 0) setPositions((p) => ({ ...p, ...Object.fromEntries(moved) }));
          }}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          edgesReconnectable={false}
          deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
          fitView
        >
          <Background />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
    </div>
  );
}
