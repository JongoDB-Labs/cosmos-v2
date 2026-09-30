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
import { getBrand } from "@/lib/brand";
// Registers a composed plugin's product profile before getBrand() reads it.
// PRODUCT_PROFILES is a module-level singleton, so without this the brand
// depends on whether some OTHER route pulled the seam in first — see
// src/lib/brand/__tests__/brand-registration.arch.test.ts.
import "@/lib/plugins/registry/server";

type PageParams = {
  params: Promise<{ orgSlug: string }>;
};

export default async function McpServersSettingsPage({ params }: PageParams) {
  const { orgSlug } = await params;
  const ctx = await getAuthContext(orgSlug);
  // This page is already dynamic (getAuthContext reads cookies), so the read
  // happens per request rather than being inlined at build.
  const brand = getBrand();
  if (!ctx) redirect("/");
  // Gate the settings page itself; the API enforces the same check on write.
  if (!canViewSettings(ctx, "/settings/mcp-servers")) {
    return (
      <PageShell
        title="MCP Servers"
        description={`Register Model Context Protocol servers (Slack, Notion, etc.) so ${brand.agentName} — the AI chat assistant — can call their tools.`}
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
      description={`Register Model Context Protocol servers (Slack, Notion, etc.) so ${brand.agentName} — the AI chat assistant — can call their tools.`}
    >
      <HydrationBoundary state={dehydrate(qc)}>
        <McpServersManager orgId={ctx.orgId} />
      </HydrationBoundary>
    </PageShell>
  );
}
