import { Permission, hasPermission } from "@/lib/rbac/permissions";
import type { AuthContext } from "@/lib/rbac/check";

/**
 * Who may see WHOSE time, and who may see the money on it.
 *
 * `TIME_READ` is held by MEMBER and VIEWER — it is the bit for "this org does
 * timekeeping and you are part of it", not for "you may read everyone's". The
 * list route treated it as the latter: `userId` was an optional filter, the
 * client never sent it, so the default response was every entry in the org
 * with its `rate` attached. A read-only viewer could enumerate the whole
 * company's hours and billing rates.
 *
 * The write paths on the same resource were always careful — PUT and DELETE
 * both verify `existing.userId === ctx.userId` and refuse non-DRAFT edits.
 * Reads simply never got the same treatment.
 *
 * Two SEPARATE questions, because they have different answers:
 *
 *   1. WHOSE rows may I see?   → TIME_READ_ALL (approvers, finance, admins)
 *   2. May I see the rate?     → FINANCE_READ, or it is my own row
 *
 * They are separate because a supervisor approving hours needs to see the
 * hours and has no business seeing the money — and because `rate` becomes
 * cost rate (compensation data) once rate cards land.
 */

/** May this actor read time entries belonging to OTHER users? */
export function canReadAllTime(ctx: AuthContext): boolean {
  return hasPermission(ctx.permissions, Permission.TIME_READ_ALL);
}

/**
 * May this actor see the `rate` on this particular entry? Own rows always —
 * the actor typed the number. Other people's only with FINANCE_READ.
 */
export function canSeeRate(ctx: AuthContext, entryUserId: string): boolean {
  return (
    entryUserId === ctx.userId ||
    hasPermission(ctx.permissions, Permission.FINANCE_READ)
  );
}

/**
 * Strip `rate` from any entry whose money this actor may not see.
 *
 * Redacts to `null` rather than deleting the key so the response shape stays
 * stable for clients (an absent key and a null both render blank, but a
 * missing key breaks a destructure).
 *
 * The single choke point for BOTH the list and single-entry routes — a second
 * hand-rolled copy is how one of them drifts.
 */
export function redactRates<T extends { userId: string; rate?: unknown }>(
  ctx: AuthContext,
  entries: T[],
): T[] {
  return entries.map((e) =>
    canSeeRate(ctx, e.userId) ? e : { ...e, rate: null },
  );
}
