import type { Prisma } from "@prisma/client";

/**
 * Allocation shared by every path that creates a work item.
 *
 * A second creation path is how two callers come to disagree about what a new
 * item looks like — one numbers tickets differently, another lands items on top
 * of a column instead of the bottom.
 *
 * ## Why there is a lock in here
 *
 * `(org_id, project_id, ticket_number)` is UNIQUE, and the number is chosen by
 * reading the current maximum and adding one. That is a read-modify-write, and
 * a transaction does NOT make it safe: a transaction gives atomicity, not
 * mutual exclusion. Postgres runs at READ COMMITTED by default, so two
 * overlapping transactions each read the same committed maximum, each compute
 * the same next number, and the loser dies on the unique constraint.
 *
 * This is not theoretical. Measured on a scratch database, eight concurrent
 * creates in one project through this very function produced **two rows and six
 * `P2002` failures** — a user-visible 500 on the most common write in the
 * product whenever two people add a ticket to the same project at once. It
 * surfaced as a ~1-in-4 flake in the DB-backed specs, which is a much politer
 * messenger than the alternative.
 *
 * (An earlier version of this comment claimed that taking a transaction client
 * was itself the protection. It was wrong, and it is very likely why six other
 * call sites felt safe hand-rolling the same `max + 1` inline.)
 *
 * So allocation takes a Postgres **advisory transaction lock** keyed on the
 * project. Properties that make it the right tool here:
 *
 *  - released automatically when the transaction ends, commit or rollback, so
 *    it cannot leak a stuck project the way a table row lock held by a crashed
 *    client would;
 *  - scoped to one project, so unrelated projects never wait on each other;
 *  - free of any schema change, backfill, or new failure mode on existing data.
 *
 * The considered alternative was a `ticketCounter` column on `Project` bumped
 * with `UPDATE … RETURNING`. It is a touch faster and self-documenting, but it
 * needs a migration, a backfill from the current maxima, and it silently
 * desynchronises the moment anything writes a `ticketNumber` without going
 * through the counter. Worth revisiting; not worth coupling to this fix.
 *
 * ## The one way to hold this wrong
 *
 * `pg_advisory_xact_lock` is scoped to the *current transaction*. Hand these
 * functions the plain `prisma` client instead of a transaction client and the
 * lock is taken and released by its own implicit single-statement transaction,
 * leaving the create that follows completely unprotected — with no error to
 * show for it. Always call these inside `prisma.$transaction`.
 */

type Tx = Prisma.TransactionClient;

/**
 * Namespace for every advisory lock this module takes, so a key can never
 * collide with an advisory lock some unrelated subsystem chooses later. Any
 * stable integer does; this one spells "TKT" loosely enough.
 */
const TICKET_LOCK_NAMESPACE = 8471;

/**
 * Serialise ticket allocation for one project.
 *
 * `hashtext` collapses the uuid to an int32, so two different projects can in
 * principle share a key and serialise against each other unnecessarily. That
 * costs a little concurrency in an astronomically rare case and is never a
 * correctness problem — which is the right direction for this trade to fail in.
 */
async function lockProjectTickets(tx: Tx, projectId: string): Promise<void> {
  // `$executeRaw`, not `$queryRaw`: the function returns `void`, and $queryRaw
  // tries to deserialize the result column and fails on that pseudo-type. The
  // lock is still taken — the statement runs either way — so the failure mode
  // was an exception AFTER acquiring, which reads as "no collisions" precisely
  // because nothing got created at all.
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(${TICKET_LOCK_NAMESPACE}::int, hashtext(${projectId}))
  `;
}

/**
 * Next ticket number for a project — `PRJ-<n>` counts up per project.
 *
 * Blocks until any other transaction allocating in this project has finished,
 * so the maximum read here is the real one.
 */
export async function allocateTicketNumber(
  tx: Tx,
  where: { orgId: string; projectId: string }
): Promise<number> {
  await lockProjectTickets(tx, where.projectId);
  const max = await tx.workItem.aggregate({
    where,
    _max: { ticketNumber: true },
  });
  return (max._max.ticketNumber ?? 0) + 1;
}

/**
 * First number of a contiguous block of `count` ticket numbers, for the callers
 * that create several items at once (converting a table to issues, duplicating
 * an item with its children).
 *
 * Those callers can equally take a single `allocateTicketNumber` and increment
 * from it — the lock is held until their transaction ends, so nothing else can
 * allocate in between. This exists because saying "reserve five" in the code is
 * clearer than a bare `++` and a comment promising it is safe.
 */
export async function allocateTicketNumbers(
  tx: Tx,
  where: { orgId: string; projectId: string },
  count: number
): Promise<number> {
  if (count < 1) throw new Error(`allocateTicketNumbers: count must be >= 1, got ${count}`);
  return allocateTicketNumber(tx, where);
}

/**
 * Next sort position at the BOTTOM of a column, where new work belongs.
 *
 * Deliberately unlocked. `sortOrder` carries no unique constraint, so the worst
 * a collision does is put two items at the same position, where the list's
 * tie-break decides the order — a cosmetic wobble, not a failed write. Taking a
 * lock to prevent it would serialise every create in a column for no real gain.
 */
export async function allocateSortOrder(
  tx: Tx,
  where: { orgId: string; projectId: string; columnKey: string }
): Promise<number> {
  const max = await tx.workItem.aggregate({
    where,
    _max: { sortOrder: true },
  });
  return (max._max.sortOrder ?? -1) + 1;
}
