import { Suspense } from "react";
import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { PageShell } from "@/components/ui/page-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { PartnersList } from "@/components/partners/partners-list";

type PageParams = { params: Promise<{ orgSlug: string }> };

/**
 * Cache Components is ON: `await params` and any cookie reads
 * (`getAuthContext`) must live inside a <Suspense> boundary. The synchronous
 * default export ships a header skeleton; <PartnersContent> awaits params +
 * auth behind that boundary. Modeled on `(dashboard)/[orgSlug]/projects/page.tsx`.
 */
export default function PartnersPage({ params }: PageParams) {
  return (
    <Suspense fallback={<PartnersPageSkeleton />}>
      <PartnersContent params={params} />
    </Suspense>
  );
}

async function PartnersContent({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  return (
    <PageShell
      title="Partners"
      description="Vendors, clients, and contractors your organization works with."
      maxWidth="7xl"
    >
      <PartnersList orgId={ctx.orgId} />
    </PageShell>
  );
}

function PartnersPageSkeleton() {
  return (
    <div className="mx-auto max-w-7xl p-8">
      <div className="mb-8">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="mt-2 h-4 w-72" />
      </div>
      <div className="flex flex-col gap-4">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-24 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}
