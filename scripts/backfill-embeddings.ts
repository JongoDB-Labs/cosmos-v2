// One-time backfill: populate the pgvector `embedding` column for
// Note/WorkItem/Contract/SyncMeeting rows created before embed-on-write landed
// (or before the pgvector migration).
//
// Run with:
//   DATABASE_URL=... npx tsx scripts/backfill-embeddings.ts
//
// Idempotent — only touches rows where "embedding" IS NULL. Safe to re-run
// after a partial failure.
//
// NOTE: the `embedding` column is an Unsupported("vector(384)") type, so the
// Prisma client can't read/write it. We select NULL-embedding ids via raw SQL
// and write each embedding through storeEmbedding() (raw UPDATE).
//
// TODO(rag): once we have a job queue, schedule this as a periodic sweep
// instead of a manual ops command.

import { PrismaClient } from "@prisma/client";
import { storeEmbedding, type EmbeddableTable } from "../src/lib/rag/embed";

const prisma = new PrismaClient();

const BATCH = 100;

/** Fetch up to BATCH ids of rows still missing an embedding for `table`. */
async function nullEmbeddingIds(table: EmbeddableTable): Promise<string[]> {
  // `table` is a fixed union (never user input) → safe to interpolate.
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT "id" FROM "${table}" WHERE "embedding" IS NULL LIMIT ${BATCH}`,
  );
  return rows.map((r) => r.id);
}

async function backfillNotes(): Promise<number> {
  let done = 0;
  while (true) {
    const ids = await nullEmbeddingIds("notes");
    if (ids.length === 0) break;
    const rows = await prisma.note.findMany({
      where: { id: { in: ids } },
      select: { id: true, title: true, content: true },
    });
    for (const row of rows) {
      await storeEmbedding("notes", row.id, `${row.title}\n${row.content}`);
      done++;
    }
    console.log(`  notes: ${done} processed`);
  }
  return done;
}

async function backfillWorkItems(): Promise<number> {
  let done = 0;
  while (true) {
    const ids = await nullEmbeddingIds("work_items");
    if (ids.length === 0) break;
    const rows = await prisma.workItem.findMany({
      where: { id: { in: ids } },
      select: { id: true, title: true, description: true },
    });
    for (const row of rows) {
      await storeEmbedding("work_items", row.id, `${row.title}\n${row.description}`);
      done++;
    }
    console.log(`  work_items: ${done} processed`);
  }
  return done;
}

async function backfillContracts(): Promise<number> {
  let done = 0;
  while (true) {
    const ids = await nullEmbeddingIds("contracts");
    if (ids.length === 0) break;
    const rows = await prisma.contract.findMany({
      where: { id: { in: ids } },
      select: { id: true, title: true, terms: true, notes: true },
    });
    for (const row of rows) {
      const text = `${row.title}\n${row.terms ?? ""}\n${row.notes ?? ""}`;
      await storeEmbedding("contracts", row.id, text);
      done++;
    }
    console.log(`  contracts: ${done} processed`);
  }
  return done;
}

async function backfillMeetings(): Promise<number> {
  let done = 0;
  while (true) {
    const ids = await nullEmbeddingIds("sync_meetings");
    if (ids.length === 0) break;
    const rows = await prisma.syncMeeting.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        title: true,
        notes: true,
        transcript: true,
        aiSummary: true,
      },
    });
    for (const row of rows) {
      const text = `${row.title}\n${row.notes}\n${row.aiSummary ?? ""}\n${row.transcript ?? ""}`;
      await storeEmbedding("sync_meetings", row.id, text);
      done++;
    }
    console.log(`  meetings: ${done} processed`);
  }
  return done;
}

async function main() {
  console.log("Backfilling embeddings for notes…");
  const n = await backfillNotes();
  console.log("Backfilling embeddings for work items…");
  const w = await backfillWorkItems();
  console.log("Backfilling embeddings for contracts…");
  const c = await backfillContracts();
  console.log("Backfilling embeddings for meetings…");
  const m = await backfillMeetings();
  console.log(
    `Done. notes=${n} work_items=${w} contracts=${c} meetings=${m}`
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
