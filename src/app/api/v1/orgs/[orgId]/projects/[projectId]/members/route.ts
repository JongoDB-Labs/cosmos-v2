import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requireProjectRead } from "@/lib/rbac/require-project-read";
import { memberDisclosure } from "@/lib/members/scoped-roster.server";
import { success, handleApiError, getIpAddress } from "@/lib/api-helpers";
import { removeProjectMember, setProjectMember } from "@/lib/projects/membership.server";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

async function resolve(orgId: string, projectId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return { error: new Response("Not found", { status: 404 }) };
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return { error: new Response("Unauthorized", { status: 401 }) };
  // Tenant isolation: the project must belong to this org.
  const project = await prisma.project.findFirst({
    where: { id: projectId, orgId },
    select: { id: true },
  });
  if (!project) return { error: new Response("Not found", { status: 404 }) };
  return { ctx };
}

async function authenticate(orgId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return { error: new Response("Not found", { status: 404 }) };
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return { error: new Response("Unauthorized", { status: 401 }) };
  return { ctx };
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const r = await resolve(orgId, projectId);
    if (r.error) return r.error;
    await requireProjectRead(r.ctx, projectId, "PROJECT_READ");
    const people = await memberDisclosure(r.ctx);

    // Explicit select throughout — OrgMember.permissions is a permission mask
    // and must never ride out in a response payload.
    const members = await prisma.projectMember.findMany({
      where: { projectId },
      select: {
        id: true,
        orgMemberId: true,
        role: true,
        orgMember: {
          select: {
            userId: true,
            // isBot distinguishes a real person from an agent (the Foreman
            // plugin registers one). Consumers that allocate human capacity
            // filter on it — see lib/intervals/allocatable-members.ts.
            user: { select: { displayName: true, email: true, avatarUrl: true, isBot: true } },
          },
        },
        teamMembers: { select: { teamId: true } },
      },
    });
    return success(
      members.filter((m) => people.inRoster(m.orgMember.userId)).map((m) => ({
        id: m.id,
        orgMemberId: m.orgMemberId,
        role: m.role,
        userId: m.orgMember.userId,
        displayName: m.orgMember.user.displayName,
        ...(people.emails && { email: m.orgMember.user.email }),
        avatarUrl: m.orgMember.user.avatarUrl,
        isBot: m.orgMember.user.isBot,
        teamIds: m.teamMembers.map((tm) => tm.teamId),
      })),
    );
  } catch (e) {
    return handleApiError(e);
  }
}

// The roster writes and their gate live in the membership service, which the
// assistant's people tools call too: one rule, two entry points.

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const r = await authenticate(orgId);
    if (r.error) return r.error;
    const body = await request.json().catch(() => null);
    return success(await setProjectMember(r.ctx, projectId, body, { ipAddress: getIpAddress(request) }));
  } catch (e) {
    return handleApiError(e);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const r = await authenticate(orgId);
    if (r.error) return r.error;
    const body = await request.json().catch(() => null);
    await removeProjectMember(r.ctx, projectId, body, { ipAddress: getIpAddress(request) });
    return success({ removed: true });
  } catch (e) {
    return handleApiError(e);
  }
}
