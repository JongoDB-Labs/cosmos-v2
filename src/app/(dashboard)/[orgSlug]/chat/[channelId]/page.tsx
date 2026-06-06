import { Suspense } from "react";
import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { ChatSidebar } from "@/components/chat/chat-sidebar";
import { ChannelView } from "@/components/chat/channel-view";

type PageParams = { params: Promise<{ orgSlug: string; channelId: string }> };

// unstable_instant temporarily removed — see [orgSlug]/page.tsx comment.

/**
 * Chat is a full-bleed surface, not a padded content page — so it fills the
 * shell's <main> via h-full (which resolves against main's definite height and
 * automatically accounts for the mobile bottom-nav padding) instead of a
 * brittle 100vh calc under PageShell's padding, which pushed the composer
 * below the fold. The page-level <h1> is sr-only so a11y keeps a single H1
 * while the visible channel name lives in the channel header.
 */
export default function ChannelPage({ params }: PageParams) {
  return (
    <div className="flex h-full flex-col">
      <h1 className="sr-only">Chat</h1>
      <Suspense
        fallback={
          <div className="text-sm text-muted-foreground p-4">Loading…</div>
        }
      >
        <Inner params={params} />
      </Suspense>
    </div>
  );
}

async function Inner({ params }: { params: PageParams["params"] }) {
  const { orgSlug, channelId } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");
  return (
    <div className="flex min-h-0 flex-1">
      <div className="hidden md:block shrink-0">
        <ChatSidebar orgId={ctx.orgId} activeChannelId={channelId} />
      </div>
      <ChannelView orgId={ctx.orgId} channelId={channelId} userId={ctx.userId} />
    </div>
  );
}
