/**
 * Dark-ship parity (GitHub's rollout technique for its issue-search rebuild).
 *
 * On a sample of real Issues searches, after the response has been sent, run
 * the same filter through CQL (`fromWorkItemFilter` → executeCql) and compare
 * the page of ids and the total with what the legacy builder returned. Logs a
 * `[cql-parity]` line with counts only: never titles, never ids.
 *
 * Sample rate: CQL_PARITY_SAMPLE (0..1). Default 0.05 in production and 1 in
 * any other environment, so staging compares everything. Cut over once the
 * logs show zero mismatches for 7 days.
 */
import { after } from "next/server";
import type { AuthContext } from "@/lib/rbac/check";
import type { WorkItemFilter, WorkItemSort } from "@/lib/work-items/query/filter";
import type { RunQueryResult } from "@/lib/work-items/query/project";
import { fromWorkItemFilter } from "./adapters";
import { executeCql } from "./execute.server";
import { CqlError } from "./errors";

export function paritySampleRate(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CQL_PARITY_SAMPLE;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
  }
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
      { page: args.page, pageSize: args.pageSize, timeoutMs: 10_000, countTimeoutMs: 10_000 },
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
  rand: () => number = Math.random,
): void {
  if (rand() >= paritySampleRate()) return;
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
