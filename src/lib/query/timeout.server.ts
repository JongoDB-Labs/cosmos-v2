/**
 * A statement budget for the query layer's own reads. Its own module so the
 * resolver can use it without importing the executor (which imports the
 * resolver).
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { CqlError, diag } from "./errors";

const TIMEOUT_RE = /statement timeout|canceling statement|57014/i;

/** Run `fn` in a transaction whose statements are cancelled after `ms`. */
export async function withStatementTimeout<T>(ms: number, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        // set_config(..., true) is SET LOCAL: it ends with this transaction.
        // A bound parameter, so no SQL is ever built from a string.
        await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(Math.round(ms))}, true)`;
        return fn(tx);
      },
      { timeout: ms + 5_000, maxWait: 5_000 },
    );
  } catch (e) {
    if (TIMEOUT_RE.test(String((e as Error)?.message ?? ""))) {
      throw new CqlError(
        [diag("", "CQL_TIMEOUT", "This query took too long. Narrow it with a project, a sprint or a date range.")],
        422,
      );
    }
    throw e;
  }
}
