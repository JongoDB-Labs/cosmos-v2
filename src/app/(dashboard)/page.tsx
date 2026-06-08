import { getCurrentUser } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { Plus } from "lucide-react";
import { OrgPickerGrid, type PickerOrg } from "@/components/orgs/org-picker-grid";

export default async function DashboardHomePage() {
  const currentUser = await getCurrentUser();
  if (!currentUser) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { id: currentUser.id },
    include: {
      memberships: {
        include: {
          org: {
            include: { projects: { where: { archived: false } } },
          },
        },
      },
    },
  });

  if (!user) redirect("/login");

  const orgs = user.memberships;

  if (orgs.length === 1) {
    redirect(`/${orgs[0].org.slug}`);
  }

  const pickerOrgs: PickerOrg[] = orgs.map((m) => ({
    id: m.org.id,
    name: m.org.name,
    slug: m.org.slug,
    plan: m.org.plan,
    role: m.role,
    logoUrl: m.org.logoUrl,
    projectCount: m.org.projects.length,
  }));

  return (
    <div className="flex-1 p-8">
      <h1 className="text-2xl font-semibold mb-6">Your Organizations</h1>
      {orgs.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-muted-foreground mb-4">
            You&apos;re not a member of any organization yet.
          </p>
          <Link
            href="/onboarding"
            className={cn(buttonVariants(), "gap-2")}
          >
            <Plus className="h-4 w-4" />
            Create Organization
          </Link>
        </div>
      ) : (
        <OrgPickerGrid orgs={pickerOrgs} />
      )}
    </div>
  );
}
