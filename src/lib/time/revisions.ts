import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";

/**
 * What a time entry used to say, and who changed it.
 *
 * `logAudit` already records that an entry was updated and which FIELD NAMES
 * moved. That is not enough for the question an auditor actually asks — "this
 * row says 8 hours, what did it say before, who changed it, when, and why?" —
 * and a field name without its value cannot answer it.
 *
 * Append-only. Nothing here updates or deletes a revision.
 */

/** The fields whose history is worth keeping. */
const TRACKED = [
  "date",
  "hours",
  "rate",
  "description",
  "projectId",
  "workItemId",
  "clinId",
  "billableType",
  "status",
  "client",
  "tags",
  "timesheetId",
  "voidedAt",
  "voidReason",
] as const;

type TrackedKey = (typeof TRACKED)[number];

/**
 * A JSON-safe snapshot of an entry.
 *
 * Prisma hands back `Decimal` for `rate` and `Date` for `date`/`voidedAt`,
 * neither of which survives a Json column meaningfully — a Decimal serialises
 * to `{}` in some paths, which would silently record "the rate used to be
 * nothing". Everything is normalised to a primitive here.
 */
export function snapshotEntry(
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of TRACKED) {
    const value = entry[key];
    if (value === undefined) continue;
    if (value === null) out[key] = null;
    else if (value instanceof Date) out[key] = value.toISOString();
    else if (Array.isArray(value)) out[key] = value;
    else if (typeof value === "object") out[key] = String(value); // Decimal
    else out[key] = value;
  }
  return out;
}

/** Only the keys that actually moved, comparing normalised snapshots. */
export function diffSnapshots(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const key of TRACKED as readonly TrackedKey[]) {
    const before = previous[key];
    const after = next[key];
    if (after === undefined) continue;
    // JSON compare so arrays (tags) and normalised scalars compare by value.
    if (JSON.stringify(before) !== JSON.stringify(after)) changed[key] = after;
  }
  return changed;
}

/**
 * Record one revision. Returns null when nothing actually changed — a no-op
 * save should not manufacture history, or the trail fills with rows that say
 * nothing and the real changes become hard to find.
 */
export async function recordRevision(params: {
  orgId: string;
  timeEntryId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  actorId: string;
  actorIp?: string | null;
  reason?: string | null;
}): Promise<{ id: string } | null> {
  const previous = snapshotEntry(params.before);
  const changed = diffSnapshots(previous, snapshotEntry(params.after));
  if (Object.keys(changed).length === 0) return null;

  return prisma.timeEntryRevision.create({
    data: {
      orgId: params.orgId,
      timeEntryId: params.timeEntryId,
      // The snapshots are built from primitives only (see snapshotEntry), so
      // they are valid JSON — Prisma's InputJsonValue just cannot infer that
      // from Record<string, unknown>.
      previous: previous as Prisma.InputJsonValue,
      changed: changed as Prisma.InputJsonValue,
      reason: params.reason ?? null,
      actorId: params.actorId,
      actorIp: params.actorIp ?? null,
    },
    select: { id: true },
  });
}
