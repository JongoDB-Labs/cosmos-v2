import { prisma } from "@/lib/db/client";
import { Permission } from "@/lib/rbac/permissions";
import { ComplianceFramework, ControlStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { assertPermission, loadAuthContext, type ToolContext } from "./_ctx";
import { scopedRosterUserIds } from "@/lib/members/scoped-roster.server";
import { escapeLike } from "@/lib/query/like";

const querySchema = z.object({
  framework: z.nativeEnum(ComplianceFramework).optional(),
  status: z.nativeEnum(ControlStatus).optional(),
  limit: z.number().int().positive().optional(),
});

/** Read-only "run a compliance check": per-status summary + matching controls. */
export async function queryComplianceControls(
  input: Record<string, unknown>,
  ctx: ToolContext
) {
  const denied = await assertPermission(ctx, Permission.COMPLIANCE_READ);
  if (denied) return denied;

  const parsed = querySchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const { framework, status, limit } = parsed.data;

  const where: Prisma.ComplianceControlWhereInput = { orgId: ctx.orgId };
  if (framework) where.framework = framework;

  // Per-status summary respects the framework filter but not the status filter,
  // so the model can report e.g. "87 of 110 implemented, 1 failed".
  const grouped = await prisma.complianceControl.groupBy({
    by: ["status"],
    where,
    _count: true,
  });
  const summary: Record<string, number> = {};
  let total = 0;
  for (const g of grouped) {
    summary[g.status] = g._count;
    total += g._count;
  }

  const controls = await prisma.complianceControl.findMany({
    where: { ...where, ...(status ? { status } : {}) },
    take: Math.min(limit ?? 50, 200),
    orderBy: [{ framework: "asc" }, { controlId: "asc" }],
    select: { controlId: true, framework: true, title: true, status: true, notes: true, dueDate: true },
  });

  return { total, summary, count: controls.length, controls };
}

const updateSchema = z.object({
  controlId: z.string().min(1),
  framework: z.nativeEnum(ComplianceFramework).optional(),
  status: z.nativeEnum(ControlStatus).optional(),
  notes: z.string().optional(),
  dueDate: z.string().optional(),
});

/** Drive remediation: set a control's status / POA&M note / due date. */
export async function updateComplianceControl(
  input: Record<string, unknown>,
  ctx: ToolContext
) {
  const denied = await assertPermission(ctx, Permission.COMPLIANCE_MANAGE);
  if (denied) return denied;

  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const d = parsed.data;

  const existing = await prisma.complianceControl.findFirst({
    where: { orgId: ctx.orgId, controlId: d.controlId, ...(d.framework ? { framework: d.framework } : {}) },
    orderBy: { framework: "asc" },
  });
  if (!existing) {
    return { error: `No compliance control '${d.controlId}'${d.framework ? ` in ${d.framework}` : ""} found in this org.` };
  }

  const statusChanged = d.status !== undefined && d.status !== existing.status;
  const updated = await prisma.complianceControl.update({
    where: { id: existing.id },
    data: {
      ...(d.status !== undefined ? { status: d.status } : {}),
      ...(d.notes !== undefined ? { notes: d.notes } : {}),
      ...(d.dueDate !== undefined ? { dueDate: d.dueDate ? new Date(d.dueDate) : null } : {}),
      ...(statusChanged ? { assessedById: ctx.userId, assessedAt: new Date() } : {}),
    },
    select: { id: true, controlId: true, framework: true, title: true, status: true, notes: true, dueDate: true },
  });
  return { updated: true, previousStatus: existing.status, ...updated };
}

/** People in the org (name, email, role) — so the AI can assign + notify. */
const listMembersSchema = z.object({
  query: z.string().trim().max(100).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export async function listOrgMembers(
  input: Record<string, unknown>,
  ctx: ToolContext
) {
  const denied = await assertPermission(ctx, Permission.ORG_READ);
  if (denied) return denied;
  const parsed = listMembersSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return { error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const { query, limit } = parsed.data;
  const auth = await loadAuthContext(ctx);
  if (!auth) return { error: "Insufficient permissions" };

  // The roster GET /members returns this caller: the whole org for a session,
  // only the scoped projects' people for a project-scoped key.
  const roster = await scopedRosterUserIds(auth);
  // Looking someone up by name ("who is Sam?") matches the name or the email,
  // case-insensitively, so the model need not page the whole roster.
  const match = query
    ? {
        user: {
          OR: [
            { displayName: { contains: escapeLike(query), mode: "insensitive" as const } },
            { email: { contains: escapeLike(query), mode: "insensitive" as const } },
          ],
        },
      }
    : {};
  const members = await prisma.orgMember.findMany({
    where: { orgId: ctx.orgId, ...(roster ? { userId: { in: roster } } : {}), ...match },
    select: { userId: true, role: true, user: { select: { displayName: true, email: true } } },
    orderBy: { joinedAt: "asc" },
    ...(limit ? { take: limit } : {}),
  });
  return {
    count: members.length,
    members: members.map((m) => ({ userId: m.userId, name: m.user.displayName, email: m.user.email, role: m.role })),
  };
}
