import { getAuthContext } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/client";
import { McpServersManager } from "@/components/settings/mcp-servers-manager";
import { PageShell } from "@/components/ui/page-shell";
import {
  makeServerQueryClient,
  dehydrate,
  HydrationBoundary,
} from "@/lib/query/server";
import { canViewSettings } from "@/lib/rbac/settings-access";
import { NoAccess } from "@/components/settings/no-access";

type PageParams = {
  params: Promise<{ orgSlug: string }>;
};

export default async function McpServersSettingsPage({ params }: PageParams) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  if (!ctx) redirect("/");
  // Gate the settings page itself; the API enforces the same check on write.
  if (!canViewSettings(ctx, "/settings/mcp-servers")) {
    return (
      <PageShell
        title="MCP Servers"
        description="Register Model Context Protocol servers (Slack, Notion, etc.) so Cosmo — the AI chat assistant — can call their tools."
      >
        <NoAccess what="MCP servers" />
      </PageShell>
    );
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
      description="Register Model Context Protocol servers (Slack, Notion, etc.) so Cosmo — the AI chat assistant — can call their tools."
    >
      <HydrationBoundary state={dehydrate(qc)}>
        <McpServersManager orgId={ctx.orgId} />
      </HydrationBoundary>
    </PageShell>
  );
}
