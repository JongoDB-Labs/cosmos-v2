import { prisma } from "@/lib/db/client";
import { FeedbackType, FeedbackStatus } from "@prisma/client";
import { z } from "zod";
import { Permission } from "@/lib/rbac/permissions";
import { assertPermission, type ToolContext } from "./_ctx";

/**
 * Feedback executors — the org's bug/feature backlog (FeedbackItem). Every query
 * is org-scoped. Mirrors `api/v1/orgs/[orgId]/feedback/…`.
 *
 * NOTE on permissions: the HTTP portal gates feedback on ORG_READ (any member
 * may file). The brief maps the ASSISTANT surface onto the item-lifecycle bits
 * (ITEM_READ / ITEM_CREATE / ITEM_UPDATE) so an agent's feedback reach tracks
 * its work-item reach — used here per the brief.
 *
 * The executor result carries title + description; the egress projection strips
 * both for gov tenants (exposable = id/type/status/voteCount/workItemId/createdAt).
 */

function invalid(error: z.ZodError): { error: string } {
  return { error: `Invalid input: ${error.issues.map((i) => i.message).join("; ")}` };
}

const FEEDBACK_SELECT = {
  id: true, type: true, status: true, voteCount: true, workItemId: true,
  projectId: true, authorId: true, title: true, description: true,
  createdAt: true, updatedAt: true,
} as const;

// ── list_feedback ─────────────────────────────────────────────────────────
const listSchema = z.object({
  type: z.nativeEnum(FeedbackType).optional(),
  status: z.nativeEnum(FeedbackStatus).optional(),
  limit: z.number().int().positive().optional(),
});

export async function listFeedback(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.ITEM_READ);
  if (denied) return denied;

  const parsed = listSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const { type, status, limit } = parsed.data;

  const feedback = await prisma.feedbackItem.findMany({
    where: { orgId: ctx.orgId, ...(type && { type }), ...(status && { status }) },
    orderBy: [{ voteCount: "desc" }, { createdAt: "desc" }],
    take: Math.min(limit ?? 50, 200),
    select: FEEDBACK_SELECT,
  });
  return { count: feedback.length, feedback };
}

// ── create_feedback ─────────────────────────────────────────────────────────
const createSchema = z.object({
  type: z.nativeEnum(FeedbackType).default(FeedbackType.FEATURE),
  title: z.string().min(1).max(200),
  description: z.string().max(5000).default(""),
});

export async function createFeedback(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.ITEM_CREATE);
  if (denied) return denied;

  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  const created = await prisma.feedbackItem.create({
    data: {
      orgId: ctx.orgId,
      authorId: ctx.userId,
      type: data.type,
      title: data.title,
      description: data.description,
    },
    select: FEEDBACK_SELECT,
  });
  return { created: true, id: created.id, feedback: created };
}

// ── set_feedback_status ─────────────────────────────────────────────────────
const setStatusSchema = z.object({
  feedbackId: z.string().uuid(),
  status: z.nativeEnum(FeedbackStatus),
});

export async function setFeedbackStatus(input: Record<string, unknown>, ctx: ToolContext) {
  const denied = await assertPermission(ctx, Permission.ITEM_UPDATE);
  if (denied) return denied;

  const parsed = setStatusSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data;

  const existing = await prisma.feedbackItem.findFirst({
    where: { id: data.feedbackId, orgId: ctx.orgId },
    select: { id: true },
  });
  if (!existing) return { error: "Feedback item not found" };

  const updated = await prisma.feedbackItem.update({
    where: { id: existing.id },
    data: { status: data.status },
    select: FEEDBACK_SELECT,
  });
  return { updated: true, id: updated.id, feedback: updated };
}
