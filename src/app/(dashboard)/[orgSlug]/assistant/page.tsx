import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { AssistantPanel } from "@/components/assistant/assistant-panel";

type PageParams = { params: Promise<{ orgSlug: string }> };

// Full-height assistant surface (like Chat) — see chat/[channelId]/page.tsx for
// the h-full rationale. The page-level H1 is sr-only so a11y keeps one H1.
export default async function AssistantPage({ params }: PageParams) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");
  return (
    <div className="flex h-full flex-col">
      <h1 className="sr-only">Assistant</h1>
      <AssistantPanel orgId={ctx.orgId} />
    </div>
  );
}
