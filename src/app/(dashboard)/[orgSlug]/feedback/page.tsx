import { Suspense } from "react";
import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { FeedbackPortal } from "@/components/feedback/feedback-portal";
import { PageShell } from "@/components/ui/page-shell";
import { PageSkeleton } from "@/components/ui/page-skeleton";

type PageParams = { params: Promise<{ orgSlug: string }> };

/**
 * Per Cache Components, `await params` and `getAuthContext` (a cookie read)
 * live INSIDE the <Suspense> boundary; the synchronous default export ships the
 * skeleton. The boundary also covers the portal's `useSearchParams` (the
 * `?item=` deep link).
 */
export default function FeedbackPage({ params }: PageParams) {
  return (
    <Suspense fallback={<PageSkeleton rows={6} />}>
      <FeedbackPageContent params={params} />
    </Suspense>
  );
}

async function FeedbackPageContent({ params }: PageParams) {
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
