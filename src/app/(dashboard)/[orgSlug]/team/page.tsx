import { Suspense } from "react";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { redirect, notFound } from "next/navigation";
import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import {
  hasPermission,
  isPermissionSubset,
  maskFromDb,
  Permission,
} from "@/lib/rbac/permissions";
import { TeamTable } from "./team-table";
import { InviteMemberButton } from "./invite-member-button";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default function TeamPage({ params }: PageParams) {
  return (
    <Suspense fallback={<TeamPageSkeleton />}>
      <TeamPageContent params={params} />
    </Suspense>
  );
}

async function TeamPageContent({ params }: PageParams) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  const org = await prisma.organization.findUnique({ where: { id: ctx.orgId } });
  if (!org) notFound();

  const [members, invitations, workRoles, memberWorkRoles] = await Promise.all([
    prisma.orgMember.findMany({
      where: { orgId: ctx.orgId },
      include: { user: true },
      orderBy: { joinedAt: "asc" },
    }),
    prisma.invitation.findMany({
      where: { orgId: ctx.orgId, expiresAt: { gt: new Date() } },
    }),
    // Grants are used ONLY for the server-side grantableRoleIds computation
    // below — stripped before workRoleOptions goes to the client.
    prisma.workRole.findMany({
      where: { orgId: ctx.orgId },
      select: { id: true, name: true, isBuiltIn: true, grants: true },
    }),
    prisma.orgMemberWorkRole.findMany({
      where: { orgMember: { orgId: ctx.orgId } },
      select: { orgMemberId: true, workRole: { select: { id: true, name: true } } },
    }),
  ]);

  const workRolesByMember = new Map<string, { id: string; name: string }[]>();
  for (const assignment of memberWorkRoles) {
    const list = workRolesByMember.get(assignment.orgMemberId) ?? [];
    list.push(assignment.workRole);
    workRolesByMember.set(assignment.orgMemberId, list);
  }

  const rows = [
    ...members.map((m) => ({
      kind: "member" as const,
      id: m.id,
      name: m.user.displayName,
      email: m.user.email,
      role: m.role,
      joined: m.joinedAt.toISOString(),
      avatarUrl: m.user.avatarUrl,
      workRoles: workRolesByMember.get(m.id) ?? [],
    })),
    ...invitations.map((i) => ({
      kind: "invite" as const,
      id: i.id,
      name: "Invited",
      email: i.email,
      role: i.role,
      joined: i.createdAt.toISOString(),
      avatarUrl: null,
      workRoles: [] as { id: string; name: string }[],
    })),
  ];

  // Grant ceiling: an actor may only hand out a work-role whose grants are a
  // subset of their OWN basePermissions (role base | explicit override,
  // EXCLUDING work-role grants) — never their widened `permissions` — so a
  // self-assigned grant can't be laundered into assigning new roles. Mirrors
  // the same guard used by the work-roles API routes.
  const grantableRoleIds = workRoles
    .filter((r) => isPermissionSubset(maskFromDb(r.grants), ctx.basePermissions))
    .map((r) => r.id);
  const workRoleOptions = workRoles.map(({ id, name, isBuiltIn }) => ({
    id,
    name,
    isBuiltIn,
  }));

  const canInvite = hasPermission(ctx.permissions, Permission.ORG_MANAGE_MEMBERS);

  return (
    <PageShell
      title="Team"
      description={`${members.length} members across ${org.name}`}
      actions={canInvite ? <InviteMemberButton orgId={ctx.orgId} /> : null}
    >
      <TeamTable
        rows={rows}
        workRoleOptions={workRoleOptions}
        grantableRoleIds={grantableRoleIds}
      />
    </PageShell>
  );
}

function TeamPageSkeleton() {
  return (
    <div className="mx-auto max-w-7xl p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Skeleton className="h-8 w-32" />
          <Skeleton className="mt-2 h-4 w-56" />
        </div>
        <Skeleton className="h-8 w-32" />
      </div>
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)]">
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="flex items-center gap-4 border-b border-[var(--border)] p-4 last:border-b-0"
          >
            <Skeleton className="h-8 w-8 rounded-full" />
            <div className="flex-1">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="mt-1 h-3 w-48" />
            </div>
            <Skeleton className="h-5 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
