import type { Prisma } from "@prisma/client";

/**
 * What counts as time the org has recorded.
 *
 * Three answers were live at once, and they disagreed on screen. The finance
 * summary counted APPROVED only; its AI twin carried no status filter at all,
 * so it counted private drafts; the practice layer counted SUBMITTED or
 * APPROVED in ten places. On an org whose ledger was entirely SUBMITTED, the
 * finance page reported "Billable Hours 0.0h" directly above its own table
 * showing $1,039,168 of logged time. Both halves were right by their own rule,
 * which is exactly why the screen looked broken.
 *
 * SUBMITTED counts. Handing a week in is the moment the hours stop being the
 * person's private working notes and become a claim the org can read.
 *
 * DRAFT does not. A half-written week is nobody's business but its author's,
 * and counting it puts hours into a partner's dashboard that the person who
 * logged them has not stood behind.
 *
 * APPROVED is NOT a precondition. Review is a separate lane — an org that never
 * approves anything still did the work, and gating every figure on approval
 * makes the whole product read as empty until somebody clicks. Where a screen
 * genuinely wants signed-off time only (a payroll run, a statutory report) that
 * is a deliberate, narrower filter written at the call site, not this default.
 *
 * REJECTED does not count either: it is a decision that the hours were wrong.
 *
 * Pair it with NOT_VOIDED — they answer different questions (is this entry real
 * / has it been handed in) and a query usually wants both.
 */
export const RECORDED_TIME = {
  status: { in: ["SUBMITTED", "APPROVED"] },
  // `satisfies`, not `as const`: the latter makes the array readonly and
  // Prisma's generated enum filter will not take a readonly array, so every
  // call site would need a cast — which is how a shared constant stops being
  // used.
} satisfies Prisma.TimeEntryWhereInput;
