// One-time backfill for saved filters v2 (query phase 3): write `query` for
// saved filters saved before it existed, from their legacy `filter`.
//
// Run with:
//   DATABASE_URL=... npx tsx scripts/backfill-saved-view-cql.ts [--dry-run]
//
// Idempotent: only touches rows where "query" IS NULL, so it is safe to re-run
// after a partial failure. Nothing depends on it having run — readers derive
// the query from `filter` on the fly (storedQuery) — it just makes the stored
// row the source of truth before `filter` is dropped a release later.
//
// The translation is the same lossless fromWorkItemFilter the dark-ship
// parity check compared against the legacy query builder on live traffic.

import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { fromWorkItemFilter } from "../src/lib/query/adapters";
import type { WorkItemFilter } from "../src/lib/work-items/query/filter";

const prisma = new PrismaClient<Prisma.PrismaClientOptions>({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const BATCH = 200;
const dryRun = process.argv.includes("--dry-run");

async function main() {
  let done = 0;
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.savedView.findMany({
      where: { query: { equals: Prisma.DbNull } },
      select: { id: true, filter: true },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;
    for (const r of rows) {
      const filter = (r.filter && typeof r.filter === "object" ? r.filter : {}) as WorkItemFilter;
      const query = fromWorkItemFilter(filter) as unknown as Prisma.InputJsonValue;
      if (!dryRun) await prisma.savedView.update({ where: { id: r.id }, data: { query } });
      done++;
    }
    cursor = rows[rows.length - 1].id;
  }
  console.log(`${dryRun ? "[dry run] would backfill" : "backfilled"} ${done} saved filter(s)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
