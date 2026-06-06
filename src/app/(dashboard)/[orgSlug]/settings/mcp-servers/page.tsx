import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { hasPermission, Permission } from "@/lib/rbac/permissions";
import { McpServersManager } from "@/components/settings/mcp-servers-manager";
import { PageShell } from "@/components/ui/page-shell";
import {
  makeServerQueryClient,
  dehydrate,
  HydrationBoundary,
} from "@/lib/query/server";

type PageParams = {
  params: Promise<{ orgSlug: string }>;
};

export default async function McpServersSettingsPage({ params }: PageParams) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");
  // Gate the settings page itself; the API enforces the same check on write.
  if (!hasPermission(ctx.permissions, Permission.MCP_MANAGE)) {
    redirect(`/${orgSlug}/settings`);
  }

  // Prefetch with the org-scoped key the client uses
  // (see useOrgQueryKey("mcp-servers", "list") in McpServersManager).
  const qc = makeServerQueryClient();
  await qc.prefetchQuery({
    queryKey: ["org", orgSlug, "mcp-servers", "list"],
    queryFn: () =>
      prisma.mcpServer.findMany({
        where: { orgId: ctx.orgId },
        orderBy: { createdAt: "desc" },
      }),
  });

  return (
    <PageShell
      title="MCP Servers"
      description="Register Model Context Protocol servers (Slack, Notion, etc.) so the AI chat can call their tools."
    >
      <HydrationBoundary state={dehydrate(qc)}>
        <McpServersManager orgId={ctx.orgId} />
      </HydrationBoundary>
    </PageShell>
  );
}
