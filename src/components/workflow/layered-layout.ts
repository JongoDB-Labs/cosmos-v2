/**
 * Auto-layout for the workflow canvas: statuses in bands by category, left to
 * right (To do | In progress | Done | Cancelled), with the "any status" node
 * before every band. Within a band, statuses keep the workflow's order, then
 * are sorted by where their incoming moves come from, which uncrosses most
 * edges. A workflow has at most 64 statuses, so a layered pass is enough and
 * no layout engine is loaded. Back edges ("Reopen") are drawn by React Flow.
 */
export const BAND_ORDER = ["TODO", "IN_PROGRESS", "DONE", "CANCELLED"] as const;
export const ANY_NODE = "__any__";
export const NODE_W = 160;
export const NODE_H = 48;

const COL_GAP = 90;
const ROW_GAP = 40;

/** Positions for every node id. Async so a heavier layout could replace it without changing callers. */
export async function layoutWorkflow(
  nodes: { id: string; category: string | null }[],
  edges: { id: string; source: string; target: string }[],
): Promise<Record<string, { x: number; y: number }>> {
  const bandOf = (n: { id: string; category: string | null }) =>
    n.id === ANY_NODE ? -1 : Math.max(0, BAND_ORDER.indexOf((n.category ?? "TODO") as (typeof BAND_ORDER)[number]));
  const bands = [-1, ...BAND_ORDER.map((_, i) => i)].map((b) => nodes.filter((n) => bandOf(n) === b)).filter((b) => b.length > 0);

  const row = new Map<string, number>();
  bands.forEach((band, i) => {
    if (i > 0) {
      // Barycenter of each node's sources in earlier bands; nodes with none keep their place.
      const weight = new Map(
        band.map((n, at) => {
          const from = edges.filter((e) => e.target === n.id && row.has(e.source)).map((e) => row.get(e.source)!);
          return [n.id, from.length > 0 ? from.reduce((a, b) => a + b, 0) / from.length : at];
        }),
      );
      band.sort((a, b) => weight.get(a.id)! - weight.get(b.id)!);
    }
    band.forEach((n, at) => row.set(n.id, at));
  });

  const out: Record<string, { x: number; y: number }> = {};
  bands.forEach((band, col) => {
    band.forEach((n, at) => {
      out[n.id] = { x: col * (NODE_W + COL_GAP), y: at * (NODE_H + ROW_GAP) };
    });
  });
  return out;
}
