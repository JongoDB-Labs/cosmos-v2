import { prisma } from "@/lib/db/client";
import type { AuthContext } from "@/lib/rbac/check";
import { requireProjectVisibleIf } from "@/lib/rbac/require-project-read";
import { ProblemError } from "@/lib/openapi/problem";

/**
 * A bill may name a project and the client invoice that recovered it. Both
 * ids come from the request body, so both are checked against the caller's
 * org before they are written: an unchecked id would link this org's bill to
 * another org's project (and read that project's markup) or invoice.
 *
 * The project must also be one the caller can see, as everywhere a body names
 * a project (403, the requireProjectVisibleIf convention). An invoice from
 * another org is answered like a malformed id.
 */
export async function assertBillLinks(
  ctx: AuthContext,
  orgId: string,
  links: { projectId?: string | null; invoiceId?: string | null },
): Promise<void> {
  await requireProjectVisibleIf(ctx, links.projectId);
  if (links.invoiceId) {
    const invoice = await prisma.invoice.findFirst({ where: { id: links.invoiceId, orgId }, select: { id: true } });
    if (!invoice) throw new ProblemError(400, "invalid_request", "That invoice isn't one of this organization's.");
  }
}
