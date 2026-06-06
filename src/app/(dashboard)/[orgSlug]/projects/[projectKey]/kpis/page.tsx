import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { EmptyState } from "@/components/ui/empty-state";
import { Gauge } from "lucide-react";

type PageParams = { params: Promise<{ orgSlug: string; projectKey: string }> };

export default async function KPIsPage({ params }: PageParams) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  // Project layout owns the page <h1>; this is a section, not a new page title.
  return (
    <div className="mx-auto max-w-5xl p-8">
      <EmptyState
        illustration={<Gauge className="size-10" />}
        title="Key Performance Indicators"
        description="Define and track KPIs for this project. Full KPI management is coming soon."
      />
    </div>
  );
}
