/**
 * Backlink recorder. Whenever a piece of content that can hold mentions is
 * created/updated (a chat message, a comment, a note, a work-item body), call
 * `syncReferences` to reconcile the `entity_references` rows for that source:
 * add newly-referenced targets, remove ones no longer present. Powers the
 * "Mentioned in …" panels.
 *
 * Best-effort: call sites should not fail the primary write if this throws.
 * Target ids are UUID-guarded so a malformed token can never break the txn.
 */
import { prisma } from "@/lib/db/client";
import { parseRefs, refKey } from "./refs";

export type ReferenceSourceType = "chatMessage" | "comment" | "note" | "workItem";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function syncReferences(opts: {
  orgId: string;
  sourceType: ReferenceSourceType;
  sourceId: string;
  content: string;
  createdById?: string | null;
}): Promise<void> {
  const wanted = new Map(
    parseRefs(opts.content)
      .filter((r) => UUID_RE.test(r.id))
      .map((r) => [refKey(r.type, r.id), r]),
  );

  const existing = await prisma.reference.findMany({
    where: { sourceType: opts.sourceType, sourceId: opts.sourceId },
    select: { id: true, targetType: true, targetId: true },
  });
  const existingKeys = new Set(
    existing.map((e) => refKey(e.targetType as never, e.targetId)),
  );

  const toDelete = existing
    .filter((e) => !wanted.has(refKey(e.targetType as never, e.targetId)))
    .map((e) => e.id);
  const toCreate = [...wanted.values()].filter(
    (r) => !existingKeys.has(refKey(r.type, r.id)),
  );

  if (toDelete.length === 0 && toCreate.length === 0) return;

  await prisma.$transaction([
    ...(toDelete.length
      ? [prisma.reference.deleteMany({ where: { id: { in: toDelete } } })]
      : []),
    ...(toCreate.length
      ? [
          prisma.reference.createMany({
            data: toCreate.map((r) => ({
              orgId: opts.orgId,
              sourceType: opts.sourceType,
              sourceId: opts.sourceId,
              targetType: r.type,
              targetId: r.id,
              createdById: opts.createdById ?? null,
            })),
            skipDuplicates: true,
          }),
        ]
      : []),
  ]);
}
