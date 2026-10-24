import { toast } from "sonner";
import { jsonFetch } from "@/lib/query/json-fetcher";
import type { BulkDenial, TransitionErrorBody } from "@/lib/workflow/contract";
import type { TransitionInput } from "@/components/work-items/transition-dialog";

export interface BulkChangeResult {
  updated: number;
  /** Items the workflow left alone, including any whose details the person didn't give. */
  denied: BulkDenial[];
}

/**
 * Apply one change to a selection through the bulk route, the way every bulk
 * bar does it. The workflow refuses items one by one and the rest move; items
 * a transition wants details for are asked about ONCE per transition ("Resolve,
 * 14 items"), then sent again with the answer.
 */
export async function sendBulkChange(args: {
  basePath: string;
  ids: string[];
  update: Record<string, unknown>;
  ask: (refusal: TransitionErrorBody) => Promise<TransitionInput | null>;
}): Promise<BulkChangeResult> {
  const put = (ids: string[], transition?: { id: string; input: TransitionInput }) =>
    jsonFetch<{ updated: number; denied?: BulkDenial[] }>(`${args.basePath}/work-items/bulk`, {
      method: "PUT",
      body: JSON.stringify({ ids, update: args.update, ...(transition && { transition }) }),
    });

  const first = await put(args.ids);
  let updated = first.updated;
  const denied: BulkDenial[] = [];
  const asking = new Map<string, BulkDenial[]>();
  for (const d of first.denied ?? []) {
    if (d.code === "transition_input_required" && d.transition) {
      asking.set(d.transition.id, [...(asking.get(d.transition.id) ?? []), d]);
    } else {
      denied.push(d);
    }
  }
  for (const group of asking.values()) {
    const [d] = group;
    const input = await args.ask({
      error: d.message,
      code: d.code,
      transition: { ...d.transition!, name: group.length === 1 ? d.transition!.name : `${d.transition!.name}, ${group.length} items` },
      fields: d.fields,
    });
    if (!input) {
      denied.push(...group);
      continue;
    }
    const again = await put(group.map((g) => g.id), { id: d.transition!.id, input });
    updated += again.updated;
    denied.push(...(again.denied ?? []));
  }
  return { updated, denied };
}

/**
 * The one toast a bulk change ends with: what moved, and what the workflow kept
 * back. Without a `label` a fully successful change says nothing (the surface
 * shows the result itself).
 */
export function announceBulkChange(result: BulkChangeResult, label?: string): void {
  const { updated, denied } = result;
  const items = (n: number) => `${n} item${n === 1 ? "" : "s"}`;
  const what = label ? ` — ${label}` : "";
  if (denied.length === 0) {
    if (label) toast.success(`Updated ${items(updated)}${what}`);
  } else if (updated === 0) {
    toast.error(`No items changed. ${denied[0].message}`);
  } else {
    toast.warning(`Updated ${items(updated)}${what}. ${items(denied.length)} stayed put: ${denied[0].message}`);
  }
}

/** Several bulk changes (one per project) as one result. */
export function combineBulkChanges(results: readonly BulkChangeResult[]): BulkChangeResult {
  return { updated: results.reduce((n, r) => n + r.updated, 0), denied: results.flatMap((r) => r.denied) };
}
