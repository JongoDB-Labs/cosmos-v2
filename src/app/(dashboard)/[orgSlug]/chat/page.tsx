import { Suspense } from "react";
import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { ChatSidebar } from "@/components/chat/chat-sidebar";

type PageParams = { params: Promise<{ orgSlug: string }> };

// unstable_instant temporarily removed — see [orgSlug]/page.tsx comment.

// Full-height chat surface — see [channelId]/page.tsx for the h-full rationale.
export default function ChatPage({ params }: PageParams) {
  return (
    <div className="flex h-full flex-col">
      <h1 className="sr-only">Chat</h1>
      <Suspense
        fallback={
          <div className="text-sm text-muted-foreground p-4">Loading…</div>
        }
      >
        <ChatPageContent params={params} />
      </Suspense>
    </div>
  );
}

async function ChatPageContent({ params }: { params: PageParams["params"] }) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");
  return (
    <div className="flex min-h-0 flex-1">
      <ChatSidebar orgId={ctx.orgId} />
      <div className="hidden md:grid flex-1 place-items-center text-muted-foreground text-sm">
        Pick a channel or DM to start
      </div>
    </div>
  );
}
