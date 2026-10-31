// src/lib/classification/effective.ts
import { prisma } from "@/lib/db/client";
import { isUuid } from "@/lib/ids";
import type { ClassificationLevel } from "@prisma/client";

const ORDER: ClassificationLevel[] = ["PUBLIC", "UNCLASSIFIED", "FOUO", "CUI", "CONFIDENTIAL"];

export function rankOf(level: ClassificationLevel): number {
  return ORDER.indexOf(level);
}

/**
 * The HIGHER-rank (more-restrictive) of two ceilings; `extra` may be null (adds no
 * floor — returns `base`). Used by the agent loop to FOLD a resolved opaque handle's
 * mint-time ceiling into a result's effective gate ceiling (C1): resolving a handle
 * minted under a high ceiling forces the resolving turn's result to be gated at ≥ that
 * ceiling, so a high-ceiling value can never be echoed back under a lower per-turn
 * ceiling. This only ever RAISES the ceiling (allow→deny), never lowers it.
 */
export function maxByRank(
  base: ClassificationLevel,
  extra: ClassificationLevel | null,
): ClassificationLevel {
  if (extra === null) return base;
  return rankOf(extra) > rankOf(base) ? extra : base;
}

/**
 * The effective classification CEILING for a value: max(org-ceiling row, project row).
 * Org ceiling = the DataClassification row with projectId = null. Default UNCLASSIFIED
 * (conservative — NOT public) when nothing is set. This is the MAC input to the gate.
 *
 * `projectId` may arrive from MODEL input — the agent loop reads it straight off a
 * tool call's arguments — and the model does not always send a real one: it will
 * invent a readable-looking id when it never looked the project up. This is the one
 * place that id crosses into `DataClassification.projectId`, a `@db.Uuid` column, so
 * an invented id raised Prisma P2007 (`invalid input syntax for type uuid`) HERE,
 * after the tool had already returned and outside anything the tool could catch —
 * which is how a chat asking for sprint data ended in a raw database error.
 *
 * A non-uuid is therefore dropped from the predicate rather than queried. That does
 * not lower the ceiling: `projectId` is a uuid column, so no project can hold an id
 * of that shape, and the per-project row could never have matched. The result is the
 * org row alone — exactly what Postgres returns for any id no project has. The
 * predicate is only ever omitted where it was already guaranteed to miss.
 */
export async function effectiveCeiling(
  orgId: string,
  projectId?: string | null,
): Promise<ClassificationLevel> {
  const rows = await prisma.dataClassification.findMany({
    where: {
      orgId,
      OR: isUuid(projectId)
        ? [{ projectId: null }, { projectId }]
        : [{ projectId: null }],
    },
    select: { projectId: true, level: true },
  });
  let max: ClassificationLevel = "UNCLASSIFIED";
  for (const r of rows) if (rankOf(r.level) > rankOf(max)) max = r.level;
  return max;
}

/**
 * The CONSERVATIVE classification ceiling for an org: max(org-ceiling row, EVERY
 * per-project row in that org). Default UNCLASSIFIED when the org has no rows at
 * all, exactly as `effectiveCeiling`.
 *
 * This exists because `effectiveCeiling(orgId, projectId)` answers a question
 * that needs a TRUSTWORTHY `projectId`, and the agent's read path does not have
 * one. The loop takes `projectId` off the model's own tool-call arguments, and
 * nothing verifies the executor used it:
 *
 *  - `get_work_item` takes only `itemId`, so a read of an item in a CUI project
 *    carried no project at all and gated at the org ceiling — exposing the ticket
 *    body on a commercial tenant while `list_work_items({projectId})` over the
 *    same row was withheld; and
 *  - a tool call may carry a DECOY `projectId` naming a lower-classified project.
 *    The executor ignores the extra argument, returns the high-classified row
 *    anyway, and the gate would compute the ceiling from the decoy — a
 *    model-controlled down-classification, reachable by prompt injection, since
 *    the instruction to attempt it can sit in a ticket the model is reading.
 *
 * So the read-path gate asks THIS instead: the highest ceiling anything in the
 * org could carry. It can only ever RAISE the ceiling relative to
 * `effectiveCeiling(orgId, <anything>)` (allow -> deny, never the reverse), and
 * for an org with no per-project rows — the common case — it returns exactly what
 * `effectiveCeiling(orgId)` returns, so nothing changes there.
 *
 * It takes NO projectId: there is deliberately no argument an attacker-adjacent
 * caller can steer. Cost is one indexed read (`@@unique([orgId, projectId])`
 * leads with `orgId`) returning at most one row per CLASSIFIED project; neither
 * this nor `effectiveCeiling` is memoised anywhere.
 *
 * `effectiveCeiling` keeps its existing meaning for the callers that have a
 * trusted scope: the write-path taint check (where `projectId` describes where
 * the data would actually LAND) and the feedback-comment marking policy.
 */
export async function conservativeCeiling(orgId: string): Promise<ClassificationLevel> {
  const rows = await prisma.dataClassification.findMany({
    where: { orgId },
    select: { level: true },
  });
  let max: ClassificationLevel = "UNCLASSIFIED";
  for (const r of rows) if (rankOf(r.level) > rankOf(max)) max = r.level;
  return max;
}
