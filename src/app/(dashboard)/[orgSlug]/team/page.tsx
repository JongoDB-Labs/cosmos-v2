import { Suspense } from "react";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { redirect, notFound } from "next/navigation";
import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
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

  const [members, invitations] = await Promise.all([
    prisma.orgMember.findMany({
      where: { orgId: ctx.orgId },
      include: { user: true },
      orderBy: { joinedAt: "asc" },
    }),
    prisma.invitation.findMany({
      where: { orgId: ctx.orgId, expiresAt: { gt: new Date() } },
    }),
  ]);

  const rows = [
    ...members.map((m) => ({
      kind: "member" as const,
      id: m.id,
      name: m.user.displayName,
      email: m.user.email,
      role: m.role,
      joined: m.joinedAt.toISOString(),
      avatarUrl: m.user.avatarUrl,
    })),
    ...invitations.map((i) => ({
      kind: "invite" as const,
      id: i.id,
      name: "Invited",
      email: i.email,
      role: i.role,
      joined: i.createdAt.toISOString(),
      avatarUrl: null,
    })),
  ];

  const canInvite = hasPermission(ctx.permissions, Permission.ORG_MANAGE_MEMBERS);

  return (
    <PageShell
      title="Team"
      description={`${members.length} members across ${org.name}`}
      actions={canInvite ? <InviteMemberButton orgId={ctx.orgId} /> : null}
    >
      <TeamTable rows={rows} />
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
