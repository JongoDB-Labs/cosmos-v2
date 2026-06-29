import { NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, created, handleApiError } from "@/lib/api-helpers";
import { resolveLinkSubject } from "@/lib/pm/subjects";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

/**
 * GET /pm-links?subjectType&subjectId
 * Returns every cross-reference touching the subject, in either direction, with
 * the FAR end resolved to its display title/code/page. Links whose far end no
 * longer resolves (the referenced entity was deleted) are dropped — a soft ref
 * has no FK cascade, so we prune lazily on read.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ANALYTICS_READ);

    const { searchParams } = new URL(request.url);
    const subjectType = searchParams.get("subjectType") ?? "";
    const subjectId = searchParams.get("subjectId") ?? "";
    if (!subjectType || !subjectId)
      return new Response("Bad request", { status: 400 });

    // Confirm the subject itself belongs to this org+project before listing.
    const subject = await resolveLinkSubject(subjectType, subjectId, orgId, projectId);
    if (!subject) return new Response("Not found", { status: 404 });

    const links = await prisma.pmLink.findMany({
      where: {
        orgId,
        projectId,
        OR: [
          { fromType: subjectType, fromId: subjectId },
          { toType: subjectType, toId: subjectId },
        ],
      },
      orderBy: { createdAt: "asc" },
    });

    const rows = await Promise.all(
      links.map(async (l) => {
        // The "other end" is whichever side isn't the subject.
        const isFrom = l.fromType === subjectType && l.fromId === subjectId;
        const otherType = isFrom ? l.toType : l.fromType;
        const otherId = isFrom ? l.toId : l.fromId;
        const other = await resolveLinkSubject(otherType, otherId, orgId, projectId);
        if (!other) return null;
        return {
          linkId: l.id,
          type: other.type,
          id: other.id,
          title: other.title,
          code: other.code,
          urlSeg: other.urlSeg,
        };
      }),
    );

    return success(rows.filter((r): r is NonNullable<typeof r> => r !== null));
  } catch (error) {
    return handleApiError(error);
  }
}

const createSchema = z.object({
  fromType: z.string(),
  fromId: z.string().uuid(),
  toType: z.string(),
  toId: z.string().uuid(),
});

/**
 * POST /pm-links — create a cross-reference. Both ends must resolve inside this
 * org+project (no dangling or cross-project links). A duplicate 4-tuple returns
 * the existing row (idempotent) rather than erroring.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.PROJECT_UPDATE);

    const data = createSchema.parse(await request.json());

    // A self-link is meaningless; reject it.
    if (data.fromType === data.toType && data.fromId === data.toId)
      return new Response("Bad request", { status: 400 });

    const [from, to] = await Promise.all([
      resolveLinkSubject(data.fromType, data.fromId, orgId, projectId),
      resolveLinkSubject(data.toType, data.toId, orgId, projectId),
    ]);
    if (!from || !to) return new Response("Not found", { status: 404 });

    // Idempotent: if this exact reference already exists, return it.
    const existing = await prisma.pmLink.findUnique({
      where: {
        fromType_fromId_toType_toId: {
          fromType: data.fromType,
          fromId: data.fromId,
          toType: data.toType,
          toId: data.toId,
        },
      },
    });
    if (existing) return success(existing);

    try {
      const link = await prisma.pmLink.create({
        data: {
          orgId,
          projectId,
          fromType: data.fromType,
          fromId: data.fromId,
          toType: data.toType,
          toId: data.toId,
          createdById: ctx.userId,
        },
      });
      return created(link);
    } catch (e) {
      // Lost the race to a concurrent identical insert — return the winner.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        const dupe = await prisma.pmLink.findUnique({
          where: {
            fromType_fromId_toType_toId: {
              fromType: data.fromType,
              fromId: data.fromId,
              toType: data.toType,
              toId: data.toId,
            },
          },
        });
        if (dupe) return success(dupe);
      }
      throw e;
    }
  } catch (error) {
    return handleApiError(error);
  }
}
