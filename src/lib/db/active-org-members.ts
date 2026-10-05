/**
 * The decision logic behind the removed-member filter applied in src/lib/db/client.ts.
 *
 * It lives in its own module, free of any Prisma client, so the rule that keeps a
 * removed member from reading as a current one can be tested directly. The property at
 * stake — a removed membership must not satisfy a membership read — is the one thing
 * holding ~67 query sites (every RBAC and auth path among them) correct, and it is not
 * something an integration test would reliably notice going wrong.
 */

/** Operations whose `where` is a FILTER, so narrowing it is valid input. */
const FILTERABLE = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "updateMany",
  "deleteMany",
]);

/** Operations addressing ONE row by unique key, where `removedAt` is not valid input
 *  and the row therefore has to be judged after it is read. */
const UNIQUE_READS = new Set(["findUnique", "findUniqueOrThrow"]);

export function isFilterable(operation: string): boolean {
  return FILTERABLE.has(operation);
}

export function isUniqueRead(operation: string): boolean {
  return UNIQUE_READS.has(operation);
}

type Args = Record<string, unknown> | undefined;

/** Narrow a filter to current members. */
export function withActiveFilter(args: Args): Record<string, unknown> {
  const a = (args ?? {}) as { where?: Record<string, unknown> };
  return { ...a, where: { ...(a.where ?? {}), removedAt: null } };
}

export type UniqueReadPlan = {
  args: Record<string, unknown>;
  /** Whether `removedAt` was added to the projection purely so it could be judged,
   *  and so must be stripped back out of the result. */
  injected: boolean;
};

/**
 * Make sure a unique read returns `removedAt`, because the caller's own projection may
 * leave it out — 16 call sites pass a `select`, and `loadEffectivePermissions`, the
 * gate the whole design rests on, is one of them. Without this the row would come back
 * with nothing to judge and every removed member would read as current.
 */
export function planUniqueRead(args: Args): UniqueReadPlan {
  const next = { ...((args ?? {}) as Record<string, unknown>) };
  let injected = false;

  const select = next.select as Record<string, unknown> | undefined;
  if (select && select.removedAt === undefined) {
    next.select = { ...select, removedAt: true };
    injected = true;
  }

  const omit = next.omit as Record<string, unknown> | undefined;
  if (omit && omit.removedAt) {
    const copy = { ...omit };
    delete copy.removedAt;
    next.omit = copy;
    injected = true;
  }

  return { args: next, injected };
}

export type UniqueReadVerdict<T> = { removed: boolean; row: T | null };

/** Judge a unique read: a row carrying `removedAt` is reported as absent. */
export function finishUniqueRead<T extends Record<string, unknown>>(
  row: T | null,
  injected: boolean,
): UniqueReadVerdict<T> {
  if (row && row.removedAt != null) return { removed: true, row: null };
  if (injected && row) {
    const copy = { ...row };
    delete copy.removedAt;
    return { removed: false, row: copy };
  }
  return { removed: false, row };
}
