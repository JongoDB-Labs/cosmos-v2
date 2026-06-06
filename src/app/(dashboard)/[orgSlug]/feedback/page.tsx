import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { FeedbackPortal } from "@/components/feedback/feedback-portal";
import { PageShell } from "@/components/ui/page-shell";

type PageParams = { params: Promise<{ orgSlug: string }> };

export default async function FeedbackPage({ params }: PageParams) {
  const { orgSlug } = await params;

  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");

  return (
    <PageShell
      title="Feedback"
      description="Request features, report bugs, and vote on what matters"
      maxWidth="5xl"
    >
      <FeedbackPortal orgId={ctx.orgId} />
    </PageShell>
  );
}
