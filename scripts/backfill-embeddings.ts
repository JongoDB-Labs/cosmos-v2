// One-time backfill: populate Note/WorkItem/Contract/SyncMeeting.searchVector
// for any row created before the embed-on-write hooks landed.
//
// Run with:
//   DATABASE_URL=... npx tsx scripts/backfill-embeddings.ts
//
// Idempotent — only touches rows where searchVector IS NULL. Safe to re-run
// after a partial failure.
//
// TODO(rag): once we have a job queue, schedule this as a periodic sweep
// instead of a manual ops command.

import { PrismaClient, Prisma } from "@prisma/client";
import { safeEmbedText } from "../src/lib/rag/embed";

const prisma = new PrismaClient();

const BATCH = 100;

async function backfillNotes() {
  let done = 0;
  while (true) {
    const rows = await prisma.note.findMany({
      where: { searchVector: { equals: Prisma.AnyNull } },
      take: BATCH,
      select: { id: true, title: true, content: true },
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      const sv = await safeEmbedText(`${row.title}\n${row.content}`);
      if (sv) {
        await prisma.note.update({
          where: { id: row.id },
          data: { searchVector: sv as unknown as Prisma.InputJsonValue },
        });
      }
      done++;
    }
    console.log(`  notes: ${done} processed`);
  }
  return done;
}

async function backfillWorkItems() {
  let done = 0;
  while (true) {
    const rows = await prisma.workItem.findMany({
      where: { searchVector: { equals: Prisma.AnyNull } },
      take: BATCH,
      select: { id: true, title: true, description: true },
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      const sv = await safeEmbedText(`${row.title}\n${row.description}`);
      if (sv) {
        await prisma.workItem.update({
          where: { id: row.id },
          data: { searchVector: sv as unknown as Prisma.InputJsonValue },
        });
      }
      done++;
    }
    console.log(`  work_items: ${done} processed`);
  }
  return done;
}

async function backfillContracts() {
  let done = 0;
  while (true) {
    const rows = await prisma.contract.findMany({
      where: { searchVector: { equals: Prisma.AnyNull } },
      take: BATCH,
      select: { id: true, title: true, terms: true, notes: true },
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      const text = `${row.title}\n${row.terms ?? ""}\n${row.notes ?? ""}`;
      const sv = await safeEmbedText(text);
      if (sv) {
        await prisma.contract.update({
          where: { id: row.id },
          data: { searchVector: sv as unknown as Prisma.InputJsonValue },
        });
      }
      done++;
    }
    console.log(`  contracts: ${done} processed`);
  }
  return done;
}

async function backfillMeetings() {
  let done = 0;
  while (true) {
    const rows = await prisma.syncMeeting.findMany({
      where: { searchVector: { equals: Prisma.AnyNull } },
      take: BATCH,
      select: {
        id: true,
        title: true,
        notes: true,
        transcript: true,
        aiSummary: true,
      },
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      const text = `${row.title}\n${row.notes}\n${row.aiSummary ?? ""}\n${row.transcript ?? ""}`;
      const sv = await safeEmbedText(text);
      if (sv) {
        await prisma.syncMeeting.update({
          where: { id: row.id },
          data: { searchVector: sv as unknown as Prisma.InputJsonValue },
        });
      }
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
