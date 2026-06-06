import { getCurrentUser } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { Plus } from "lucide-react";

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
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {orgs.map((m) => (
            <Link
              key={m.org.id}
              href={`/${m.org.slug}`}
              className="block rounded-lg border bg-card p-6 hover:border-primary transition-colors"
            >
              <div className="flex items-center gap-3 mb-3">
                {m.org.logoUrl ? (
                  <img
                    src={m.org.logoUrl}
                    alt={m.org.name}
                    className="h-10 w-10 rounded-md"
                  />
                ) : (
                  <div className="h-10 w-10 rounded-md bg-primary/10 flex items-center justify-center text-primary font-semibold">
                    {m.org.name.charAt(0).toUpperCase()}
                  </div>
                )}
                <div>
                  <h2 className="font-medium">{m.org.name}</h2>
                  <p className="text-xs text-muted-foreground capitalize">
                    {m.role.toLowerCase()} &middot; {m.org.plan.toLowerCase()} plan
                  </p>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                {m.org.projects.length} project{m.org.projects.length !== 1 ? "s" : ""}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
