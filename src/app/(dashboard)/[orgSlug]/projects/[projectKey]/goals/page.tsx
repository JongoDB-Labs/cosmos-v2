import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { EmptyState } from "@/components/ui/empty-state";
import { Target } from "lucide-react";

type PageParams = { params: Promise<{ orgSlug: string; projectKey: string }> };

export default async function GoalsPage({ params }: PageParams) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  // Project layout owns the page <h1>; this is a section, not a new page title.
  return (
    <div className="mx-auto max-w-5xl p-8">
      <EmptyState
        illustration={<Target className="size-10" />}
        title="Goals"
        description="Track high-level goals for this project. Full goal management is coming soon."
      />
    </div>
  );
}
