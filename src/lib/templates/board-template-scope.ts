import type { Prisma } from "@prisma/client";

/**
 * The board templates a project template contributes for `orgId`: the
 * built-in ones (no org) and the org's own.
 *
 * A board template is attached to a project template by id, and the column is
 * a single-column foreign key, so a row could point at a built-in project
 * template, which every org shares, or at another org's. Creating one is now
 * refused (`projectTemplate` in foreign-refs.ts), but a row from before that
 * would still add its board to every project another org made from the
 * template. Every read of a template's boards passes this filter.
 */
export function boardTemplatesFor(orgId: string): Prisma.BoardTemplateWhereInput {
  return { OR: [{ orgId: null }, { orgId }] };
}
