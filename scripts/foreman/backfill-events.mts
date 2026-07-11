// One-time import of .deploy/foreman-ledger.jsonl into foreman_events so the
// in-app feed starts with full history. Idempotent: an entry is skipped when a
// backfilled event with the same ticketKey+kind+ts already exists.
// Run: DATABASE_URL=<target> npx tsx scripts/foreman/backfill-events.mts <ledger-path>
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { readLedger, type LedgerEntry } from "@/lib/foreman/ledger";
import { LEDGER_KIND_MAP, type ForemanEventKind } from "@/lib/foreman/observe";

export function mapLedgerEntry(e: LedgerEntry): {
  ticketKey: string; kind: ForemanEventKind; severity: string;
  message: string; data: Record<string, unknown>; ts: Date;
} {
  const kind = LEDGER_KIND_MAP[e.resolution] ?? "error";
  return {
    ticketKey: e.ticket, kind,
    severity: e.resolution === "gated" ? "warn" : "info",
    message: `${e.ticket} ${e.resolution}${e.version ? ` v${e.version}` : ""}${e.dupOf ? ` (dup of ${e.dupOf})` : ""} — ${e.title}`,
    data: { version: e.version, dupOf: e.dupOf, classification: e.classification, backfilled: true },
    ts: new Date(e.ts),
  };
}

async function main(): Promise<void> {
  const path = process.argv[2] ?? ".deploy/foreman-ledger.jsonl";
  const entries = readLedger(path);
  let inserted = 0;
  for (const e of entries) {
    const m = mapLedgerEntry(e);
    const dupe = await prisma.foremanEvent.findFirst({
      where: { ticketKey: m.ticketKey, kind: m.kind, ts: m.ts },
      select: { id: true },
    });
    if (dupe) continue;

    // Resolve the work item by scanning delivery projects' items whose ref key
    // matches (ticketKey is "<PROJKEY>-<n>"); org comes off the item.
    // Split on the LAST "-" to separate project key from ticket number.
    const lastHyphenIdx = m.ticketKey.lastIndexOf("-");
    let wi: { id: string; orgId: string } | null = null;

    if (lastHyphenIdx > 0) {
      const projectKey = m.ticketKey.substring(0, lastHyphenIdx);
      const numberStr = m.ticketKey.substring(lastHyphenIdx + 1);
      const ticketNumber = parseInt(numberStr, 10);

      if (!isNaN(ticketNumber)) {
        const project = await prisma.project.findFirst({
          where: { key: projectKey },
          select: { id: true },
        });

        if (project) {
          const foundWi = await prisma.workItem.findFirst({
            where: { projectId: project.id, ticketNumber },
            select: { id: true, orgId: true },
          });
          if (foundWi) {
            wi = foundWi;
          }
        }
      }
    }

    await prisma.foremanEvent.create({
      data: {
        ticketKey: m.ticketKey,
        kind: m.kind,
        severity: m.severity,
        message: m.message,
        data: m.data as Prisma.InputJsonValue,
        ts: m.ts,
        orgId: wi?.orgId ?? null,
        workItemId: wi?.id ?? null,
      },
    });
    inserted++;
  }
  console.log(`backfilled ${inserted}/${entries.length} ledger entries from ${path}`);
  process.exit(0);
}

if (process.argv[1]?.endsWith("backfill-events.mts")) void main();
