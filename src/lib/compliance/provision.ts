import { prisma } from "@/lib/db/client";
import { ComplianceFramework } from "@prisma/client";
import { NIST_800_171_CONTROLS } from "./nist-800-171";

/**
 * Provision the NIST SP 800-171 / CMMC L2 control baseline for an organization
 * so a regulated (GOV) org has a complete, ready-to-assess control set
 * out-of-the-box. Each control is created as NOT_ASSESSED.
 *
 * Idempotent and non-destructive: existing controls are left untouched
 * (`update: {}`), so re-running never clobbers an in-flight assessment — safe
 * to call on org creation, on upgrade-to-GOV, or as a manual "load baseline".
 */
export async function provisionComplianceBaseline(
  orgId: string,
  opts: { framework?: ComplianceFramework } = {}
): Promise<{ framework: ComplianceFramework; count: number }> {
  const framework = opts.framework ?? ComplianceFramework.NIST_800_171;
  for (const c of NIST_800_171_CONTROLS) {
    await prisma.complianceControl.upsert({
      where: { orgId_framework_controlId: { orgId, framework, controlId: c.controlId } },
      update: {}, // never overwrite an existing assessment
      create: {
        orgId,
        framework,
        controlId: c.controlId,
        title: c.title,
        status: "NOT_ASSESSED",
      },
    });
  }
  return { framework, count: NIST_800_171_CONTROLS.length };
}
