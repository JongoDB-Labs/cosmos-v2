import type { Prisma, PrismaClient } from "@prisma/client";
import { nextProjectNumber } from "./numbering";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The next project number for this org under `pattern`, from the numbers its
 * projects already hold (archived ones included: a number, once given, stays
 * taken).
 *
 * Not reserved: two creates racing can compute the same number. The unique
 * index on (org_id, number) refuses the second, and the create route retries
 * — see isProjectNumberConflict.
 *
 * The year is the UTC year at `now`.
 */
export async function allocateProjectNumber(db: Db, orgId: string, pattern: string, now = new Date()): Promise<string> {
  const rows = await db.project.findMany({ where: { orgId, number: { not: null } }, select: { number: true } });
  return nextProjectNumber(pattern, now.getUTCFullYear(), rows.map((r) => r.number));
}

/** A unique violation on the project number, as opposed to any other. */
export function isProjectNumberConflict(e: unknown): boolean {
  const err = e as { code?: string; meta?: unknown };
  if (err?.code !== "P2002") return false;
  // Where the constraint is named depends on the engine (`meta.target`, or a
  // driver adapter's nested cause), so look for the column anywhere in it.
  return JSON.stringify(err.meta ?? {}).includes("number");
}
