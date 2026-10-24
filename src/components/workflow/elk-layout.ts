"use client";

/**
 * Auto-layout for the workflow canvas with ELK's layered algorithm, which
 * handles the back edges ("Reopen") workflows are full of. Statuses are kept
 * in swim-bands by category (To do | In progress | Done | Cancelled) through
 * ELK's partitioning.
 *
 * ELK runs in a Web Worker so a layout never blocks the page; where a worker
 * can't start, it falls back to the main thread. Either way it is only loaded
 * when the canvas is opened.
 */
import type { ELK, ElkNode } from "elkjs/lib/elk-api";

export const BAND_ORDER = ["TODO", "IN_PROGRESS", "DONE", "CANCELLED"] as const;
export const ANY_NODE = "__any__";
export const NODE_W = 160;
export const NODE_H = 48;

let elk: Promise<ELK> | null = null;

function loadElk(): Promise<ELK> {
  elk ??= (async () => {
    try {
      const { default: ElkApi } = await import("elkjs/lib/elk-api");
      return new ElkApi({
        workerFactory: () => new Worker(new URL("elkjs/lib/elk-worker.min.js", import.meta.url)),
      }) as ELK;
    } catch {
      const { default: Bundled } = await import("elkjs/lib/elk.bundled.js");
      return new Bundled() as ELK;
    }
  })();
  return elk;
}

/** Positions for every node id, from ELK. */
export async function layoutWorkflow(
  nodes: { id: string; category: string | null }[],
  edges: { id: string; source: string; target: string }[],
): Promise<Record<string, { x: number; y: number }>> {
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.partitioning.activate": "true",
      "elk.layered.spacing.nodeNodeBetweenLayers": "90",
      "elk.spacing.nodeNode": "40",
      "elk.edgeRouting": "SPLINES",
    },
    children: nodes.map((n) => ({
      id: n.id,
      width: NODE_W,
      height: NODE_H,
      layoutOptions: {
        // The "any status" node sits before every band.
        "elk.partitioning.partition": String(n.id === ANY_NODE ? -1 : Math.max(0, BAND_ORDER.indexOf((n.category ?? "TODO") as (typeof BAND_ORDER)[number]))),
      },
    })),
    edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
  const laid = await (await loadElk()).layout(graph);
  return Object.fromEntries((laid.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
}
