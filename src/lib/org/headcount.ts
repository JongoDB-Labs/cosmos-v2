import { prisma } from "@/lib/db/client";

/**
 * How many people the firm has, for per-head figures.
 *
 * Two sources disagreed on screen: the practice KPIs counted rows in
 * `employees` and reported "Across 0 active employees" while the Org page
 * listed nine people. Both were right about their own table — the org had no HR
 * records at all — and the pair still read as a broken product.
 *
 * `employees` WINS where it has rows. It is the deliberate HR record, it knows
 * who is part-time or on leave, and a firm that has filled it in has said
 * something more precise than "these people can log in".
 *
 * Org membership is the fallback, not the equal. It over-counts — a bookkeeper
 * with a login is not a fee earner — but over-counting by a couple of people
 * gives a per-head figure in the right order of magnitude, where dividing by
 * zero gives nothing at all. Guests are excluded because they are clients and
 * contractors: people the firm works WITH, not people it pays.
 *
 * Returns 0 only when the org genuinely has nobody, which callers should read
 * as "cannot compute per head" rather than as a headcount.
 */
export async function activeHeadcount(orgId: string): Promise<number> {
  const employees = await prisma.employee.count({
    where: { orgId, status: "active" },
  });
  if (employees > 0) return employees;

  return prisma.orgMember.count({
    where: { orgId, role: { not: "GUEST" } },
  });
}
