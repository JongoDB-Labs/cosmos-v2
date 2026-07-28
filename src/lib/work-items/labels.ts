/**
 * The ONLY writer of a work item's labels.
 *
 * Labels live in two places: `work_item_labels` (the source of truth) and
 * `work_items.tags` (a denormalised mirror the RAID board, the AI tools, ingest
 * and feedback all still read). Any code path that writes one without the other
 * puts them out of step, and the symptom — a label that filters correctly but
 * vanishes from the RAID board, or vice versa — is miserable to trace back. So
 * routes call this and never touch either directly.
 */
import { Prisma } from "@prisma/client";

/** Prisma client or an interactive-transaction client. */
type Db = Prisma.TransactionClient;

/**
 * Trim, drop blanks, and collapse case-variants to one entry each, keeping the
 * first spelling seen. Mirrors the migration's folding rule so a name typed
 * here resolves to the same row the backfill created.
 */
export function normalizeLabelNames(names: readonly string[]): string[] {
  const byFold = new Map<string, string>();
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const fold = name.toLowerCase();
    if (!byFold.has(fold)) byFold.set(fold, name);
  }
  return [...byFold.values()];
}

/**
 * Find-or-create the org's label rows for `names`, returning them in the
 * catalogue's own spelling.
 *
 * Raw SQL because uniqueness is a FUNCTIONAL index on `(org_id, lower(name))` —
 * Prisma has no way to express that, so `upsert` cannot target it and a
 * find-then-create would race two concurrent requests into a duplicate-key
 * error. `ON CONFLICT` makes the insert idempotent instead.
 */
export async function resolveLabels(
  db: Db,
  orgId: string,
  names: readonly string[],
): Promise<{ id: string; name: string }[]> {
  const clean = normalizeLabelNames(names);
  if (clean.length === 0) return [];

  await db.$executeRaw`
    INSERT INTO labels (org_id, name)
    SELECT ${orgId}::uuid, n
    FROM unnest(${clean}::text[]) AS n
    ON CONFLICT (org_id, lower(name)) DO NOTHING
  `;

  const folds = clean.map((n) => n.toLowerCase());
  return db.$queryRaw<{ id: string; name: string }[]>`
    SELECT id, name FROM labels
    WHERE org_id = ${orgId}::uuid AND lower(name) = ANY(${folds}::text[])
  `;
}

/**
 * Replace a work item's labels with exactly `names`.
 *
 * The mirror is written from the resolved CATALOGUE spellings, not the caller's
 * input — so tagging an item "security" when the org's label is "Security"
 * stores "Security", and the tag array cannot drift into case-variants that the
 * migration just spent effort collapsing.
 */
export async function setWorkItemLabels(
  db: Db,
  orgId: string,
  workItemId: string,
  names: readonly string[],
): Promise<{ id: string; name: string }[]> {
  const labels = await resolveLabels(db, orgId, names);
  const keep = labels.map((l) => l.id);

  // `notIn: []` is not a reliable "match everything" in SQL, so the clear-all
  // case is spelled out rather than left to an empty IN-list.
  if (keep.length === 0) {
    await db.workItemLabel.deleteMany({ where: { workItemId } });
  } else {
    await db.workItemLabel.deleteMany({
      where: { workItemId, labelId: { notIn: keep } },
    });
  }

  if (keep.length > 0) {
    await db.workItemLabel.createMany({
      data: keep.map((labelId) => ({ orgId, workItemId, labelId })),
      skipDuplicates: true,
    });
  }

  await db.workItem.update({
    where: { id: workItemId },
    data: { tags: labels.map((l) => l.name) },
  });

  return labels;
}
