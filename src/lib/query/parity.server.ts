/**
 * Dark-ship parity (GitHub's rollout technique for its issue-search rebuild).
 *
 * On a sample of real Issues searches, after the response has been sent, run
 * the same filter through CQL (`fromWorkItemFilter` → executeCql) and compare
 * the page of ids and the total with what the legacy builder returned. Logs a
 * `[cql-parity]` line with counts only: never titles, never ids.
 *
 * Who is sampled (owner decision on the #1105 review): orgs that have CQL
 * switched on, at 0.05 in production and 1 elsewhere; any other org only when
 * COSMOS_CQL_PARITY_RATE (0..1) is set explicitly, which then applies to every
 * org. Otherwise 0: an org that hasn't opted in never pays for a second query.
 * Each comparison runs its two statements one after the other, inside the
 * normal 3 s / 1.5 s budget. Cut over once the logs show zero mismatches for
 * 7 days.
 */
import { after } from "next/server";
import type { AuthContext } from "@/lib/rbac/check";
import type { WorkItemFilter, WorkItemSort } from "@/lib/work-items/query/filter";
import type { RunQueryResult } from "@/lib/work-items/query/project";
import { fromWorkItemFilter } from "./adapters";
import { executeCql } from "./execute.server";
import { CqlError } from "./errors";

export function paritySampleRate(cqlOn: boolean, env: Record<string, string | undefined> = process.env): number {
  const raw = env.COSMOS_CQL_PARITY_RATE;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
  }
  if (!cqlOn) return 0;
  return env.NODE_ENV === "production" ? 0.05 : 1;
}

export interface ParityOutcome {
  match: boolean;
  legacyTotal: number;
  cqlTotal: number | null;
  /** On the compared page: ids only the legacy builder returned / only CQL returned. */
  missing: number;
  extra: number;
  orderDiffers: boolean;
  error?: string;
}

export async function compareWithCql(
  ctx: AuthContext,
  args: { filter: WorkItemFilter; sort: WorkItemSort | undefined; page: number; pageSize: number },
  legacy: RunQueryResult,
): Promise<ParityOutcome> {
  const base = { legacyTotal: legacy.total, cqlTotal: null, missing: 0, extra: 0, orderDiffers: false };
  try {
    const r = await executeCql(
      ctx,
      { query: fromWorkItemFilter(args.filter, args.sort) },
      // One transaction at a time, in the interactive budget: parity must not
      // cost the database more than the search it shadows.
      { page: args.page, pageSize: args.pageSize, sequential: true },
    );
    const a = legacy.data.map((x) => x.id);
    const b = r.data.map((x) => x.id);
    const sa = new Set(a);
    const sb = new Set(b);
    const missing = a.filter((id) => !sb.has(id)).length;
    const extra = b.filter((id) => !sa.has(id)).length;
    // The legacy sort has no id tiebreak, so order is only compared when the
    // sets agree; equal timestamps may legitimately swap.
    const orderDiffers = missing === 0 && extra === 0 && a.join() !== b.join();
    return {
      match: r.total === legacy.total && missing === 0 && extra === 0,
      legacyTotal: legacy.total,
      cqlTotal: r.total,
      missing,
      extra,
      orderDiffers,
    };
  } catch (e) {
    const error = e instanceof CqlError ? e.diagnostics.map((d) => d.code).join(",") : "exception";
    return { ...base, match: false, error };
  }
}

/** Fire-and-forget after the response, on a sample. Never throws, never delays the user. */
export function scheduleParity(
  ctx: AuthContext,
  args: { filter: WorkItemFilter; sort: WorkItemSort | undefined; page: number; pageSize: number },
  legacy: RunQueryResult,
  cqlOn: boolean,
  rand: () => number = Math.random,
): void {
  if (rand() >= paritySampleRate(cqlOn)) return;
  try {
    after(() => runParity(ctx, args, legacy));
  } catch {
    // No request scope (a script, a unit test): parity is optional, skip it.
  }
}

async function runParity(
  ctx: AuthContext,
  args: { filter: WorkItemFilter; sort: WorkItemSort | undefined; page: number; pageSize: number },
  legacy: RunQueryResult,
): Promise<void> {
  try {
    const o = await compareWithCql(ctx, args, legacy);
    // Field NAMES used, not values: enough to find which mapping disagrees.
    const fields = Object.keys(args.filter).filter((k) => {
      const v = (args.filter as Record<string, unknown>)[k];
      return v !== undefined && !(Array.isArray(v) && v.length === 0);
    });
    console.info(`[cql-parity] ${JSON.stringify({ orgId: ctx.orgId, fields, ...o })}`);
  } catch {
    // Parity is diagnostics; it must never surface as an error.
  }
}
