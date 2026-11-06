import { z } from "zod";
import { Uuid } from "./common";

/**
 * Unbilled reimbursable costs, as the reports that show what is still to be
 * billed read them (src/lib/invoicing/reimbursables.server.ts). Amounts are
 * numbers in the org's currency, exact to the cent; totals are the sums of
 * the rows to the cent.
 */
export const UnbilledReimbursableItem = z
  .object({
    source: z.enum(["bill", "expense"]).describe("A vendor/partner bill on the project, or a reimbursable expense."),
    id: Uuid.describe("The bill's or expense's id."),
    label: z.string().describe("How the cost reads on an invoice: the vendor and their reference, or the expense's vendor and description."),
    date: z.string().nullable().describe("The bill's issue date or the expense's date (YYYY-MM-DD); null for a bill with no issue date."),
    cost: z.number().describe("The vendor's exact amount."),
    markup: z
      .object({ pct: z.number().describe("Percent (15 = 15%)."), source: z.enum(["bill", "project", "org"]) })
      .describe("The markup that applies, and which level set it."),
    markupAmount: z.number().describe("cost × pct, rounded half-up to the cent."),
    total: z.number().describe("cost + markupAmount: what the cost bills at."),
  })
  .meta({ id: "UnbilledReimbursableItem" });

export const UnbilledTotals = z
  .object({
    count: z.number().int(),
    cost: z.number(),
    markup: z.number(),
    total: z.number(),
  })
  .meta({ id: "UnbilledReimbursableTotals" });

export const ProjectUnbilledReimbursables = z
  .object({
    projectId: Uuid,
    projectKey: z.string(),
    projectName: z.string(),
    items: z.array(UnbilledReimbursableItem).describe("Oldest first: bills, then expenses."),
    totals: UnbilledTotals,
  })
  .meta({ id: "ProjectUnbilledReimbursables" });

export const UnbilledReimbursables = z
  .object({
    projects: z.array(ProjectUnbilledReimbursables).describe("Projects with something unbilled, by key. A project with nothing unbilled is left out."),
    totals: UnbilledTotals.describe("Across every project listed."),
    lines: z.enum(["one", "two"]).describe("How the org shows a re-billed cost on an invoice: one line, or the cost and the markup as two."),
  })
  .meta({ id: "UnbilledReimbursables" });
