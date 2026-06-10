import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError } from "@/lib/api-helpers";
import { z } from "zod";

type RouteParams = { params: Promise<{ orgId: string }> };

/** Org-defined reusable meeting types (extend the built-in MeetingType enum). */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.MEETING_READ);

    const types = await prisma.meetingTypeOption.findMany({
      where: { orgId },
      orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
      select: { id: true, label: true, sortOrder: true },
    });
    return success(types);
  } catch (error) {
    return handleApiError(error);
  }
}

const createSchema = z.object({
  label: z.string().trim().min(1, "Label is required").max(60),
});

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // Managing the org's meeting-type vocabulary is a meeting-creation capability.
    requirePermission(ctx, Permission.MEETING_CREATE);

    const { label } = createSchema.parse(await request.json());

    // Idempotent on (orgId, label): reuse an existing type instead of erroring,
    // so "add custom type" from the form is safe to repeat.
    const existing = await prisma.meetingTypeOption.findUnique({
      where: { orgId_label: { orgId, label } },
      select: { id: true, label: true, sortOrder: true },
    });
    if (existing) return success(existing);

    const row = await prisma.meetingTypeOption.create({
      data: { orgId, label },
      select: { id: true, label: true, sortOrder: true },
    });
    return created(row);
  } catch (error) {
    return handleApiError(error);
  }
}
