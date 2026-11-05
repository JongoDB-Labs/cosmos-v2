import { prisma } from "@/lib/db/client";
import { NotFoundError, type AuthContext } from "@/lib/rbac/check";
import { inVisibleProject } from "@/lib/rbac/require-project-read";

/**
 * An invoice on a project is exactly as visible as that project, as the
 * project's expenses are; one on no project is the org's. Not visible reads as
 * not found, so the refusal says nothing about whether the invoice exists.
 */
export async function requireInvoiceVisible(ctx: AuthContext, orgId: string, invoiceId: string): Promise<void> {
  const invoice = await prisma.invoice.findFirst({ where: { id: invoiceId, orgId }, select: { projectId: true } });
  if (!invoice || !(await inVisibleProject(ctx, invoice.projectId))) throw new NotFoundError("Invoice not found");
}
