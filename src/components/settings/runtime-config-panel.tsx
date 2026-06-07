"use client";

import { useQuery } from "@tanstack/react-query";
import { Loader2, Plug, ShieldCheck, Network } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { notifyError } from "@/lib/errors/notify";

/**
 * Runtime config (design §8) — THIN client surface. The API is the source of truth: this
 * panel GET/PATCHes /api/v1/orgs/[orgId]/runtime-config for connector enablement + the
 * breadth/mcp toggles, and (platform-owner only) PATCHes the internal tenant-class route.
 * Every gov guardrail is enforced SERVER-SIDE — the UI just disables what the server would
 * reject and surfaces a toast if it slips through.
 *
 * The breadth connector ("nango") is governed by the SEPARATE breadth toggle, so it is not
 * listed among the per-connector toggles; it's hidden entirely for gov.
 */

interface RuntimeConfigResponse {
  tenantClass: "GOV" | "COMMERCIAL";
  availableConnectors: string[];
  enabledConnectors: string[] | null; // null = all enabled
  breadthEnabled: boolean;
  mcpEnabled: boolean;
}

const BREADTH_PROVIDER = "nango";

export function RuntimeConfigPanel({
  orgId,
  isPlatformOwner,
}: {
  orgId: string;
  isPlatformOwner: boolean;
}) {
  const queryKey = useOrgQueryKey("runtime-config");
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => jsonFetch<RuntimeConfigResponse>(`/api/v1/orgs/${orgId}/runtime-config`),
  });

  const patch = useOrgMutation({
    mutationFn: (body: Partial<Pick<RuntimeConfigResponse, "enabledConnectors" | "breadthEnabled" | "mcpEnabled">>) =>
      jsonFetch<RuntimeConfigResponse>(`/api/v1/orgs/${orgId}/runtime-config`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    invalidate: [["runtime-config"]],
  });

  const flipClass = useOrgMutation({
    mutationFn: (tenantClass: "GOV" | "COMMERCIAL") =>
      jsonFetch(`/api/internal/orgs/${orgId}/tenant-class`, {
        method: "PATCH",
        body: JSON.stringify({ tenantClass }),
      }),
    invalidate: [["runtime-config"]],
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (isError || !data) {
    return <LoadError title="Couldn't load runtime config" onRetry={() => refetch()} />;
  }

  const isGov = data.tenantClass === "GOV";
  // null enabledConnectors ⇒ all enabled; otherwise membership in the explicit subset.
  const isConnectorEnabled = (provider: string) =>
    data.enabledConnectors === null || data.enabledConnectors.includes(provider);

  // The per-connector toggles exclude the breadth connector (nango) — it's governed by the
  // breadth toggle below and hidden for gov.
  const connectorList = data.availableConnectors.filter((p) => p !== BREADTH_PROVIDER);

  function toggleConnector(provider: string, next: boolean) {
    // Materialize the current effective set (null ⇒ all) then add/remove. We never include
    // the breadth provider here (it's controlled separately), so this stays a NATIVE subset
    // the gov guardrail accepts.
    const current = data!.enabledConnectors ?? connectorList;
    const set = new Set(current.filter((p) => p !== BREADTH_PROVIDER));
    if (next) set.add(provider);
    else set.delete(provider);
    patch.mutate({ enabledConnectors: [...set] });
  }

  return (
    <div className="space-y-6">
      {/* Tenant class — read-only badge; platform-owner-only flip control. */}
      <SectionCard
        icon={ShieldCheck}
        title="Tenant class"
        description="The gov designation. Flipping to GOV disables breadth + MCP. Platform-owner only."
      >
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Badge variant={isGov ? "critical" : "strategic"}>{data.tenantClass}</Badge>
            <span className="text-xs text-[var(--text-muted)]">
              {isGov ? "Gov guardrails enforced (breadth + MCP disabled)." : "Commercial — full connector breadth available."}
            </span>
          </div>
          {isPlatformOwner ? (
            <Button
              variant="outline"
              disabled={flipClass.isPending}
              onClick={() => flipClass.mutate(isGov ? "COMMERCIAL" : "GOV")}
            >
              {flipClass.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              {isGov ? "Designate COMMERCIAL" : "Designate GOV"}
            </Button>
          ) : (
            <span className="text-xs text-[var(--text-muted)]">Read-only</span>
          )}
        </div>
      </SectionCard>

      {/* Per-connector enablement. */}
      <SectionCard
        icon={Plug}
        title="Connectors"
        description="Enable or disable individual connectors for this org's AI agent."
      >
        <div className="divide-y divide-[var(--border)]">
          {connectorList.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">No connectors registered.</p>
          ) : (
            connectorList.map((provider) => (
              <div key={provider} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
                <span className="text-sm font-medium capitalize">{provider}</span>
                <ToggleSwitch
                  checked={isConnectorEnabled(provider)}
                  disabled={patch.isPending}
                  onCheckedChange={(v) => toggleConnector(provider, v)}
                  aria-label={`Toggle ${provider} connector`}
                />
              </div>
            ))
          )}
        </div>
      </SectionCard>

      {/* Breadth + MCP — hidden/disabled for gov. */}
      <SectionCard
        icon={Network}
        title="Connector breadth & MCP"
        description="Nango breadth (~180 providers) and external MCP. Disabled and locked off for GOV orgs."
      >
        <div className="divide-y divide-[var(--border)]">
          <div className="flex items-center justify-between py-3 first:pt-0">
            <div>
              <span className="text-sm font-medium">Connector breadth (Nango)</span>
              <p className="text-xs text-[var(--text-muted)]">
                {isGov ? "Locked off — GOV orgs cannot use commercial breadth." : "Adds ~180 commercial providers via the in-boundary broker."}
              </p>
            </div>
            <ToggleSwitch
              checked={data.breadthEnabled && !isGov}
              disabled={isGov || patch.isPending}
              onCheckedChange={(v) => {
                if (isGov) {
                  notifyError(new Error("GOV orgs cannot enable connector breadth."));
                  return;
                }
                patch.mutate({ breadthEnabled: v });
              }}
              aria-label="Toggle connector breadth"
            />
          </div>
          <div className="flex items-center justify-between py-3 last:pb-0">
            <div>
              <span className="text-sm font-medium">External MCP</span>
              <p className="text-xs text-[var(--text-muted)]">
                {isGov ? "Locked off for GOV orgs." : "Expose external MCP servers to the chat (dormant)."}
              </p>
            </div>
            <ToggleSwitch
              checked={data.mcpEnabled && !isGov}
              disabled={isGov || patch.isPending}
              onCheckedChange={(v) => {
                if (isGov) {
                  notifyError(new Error("GOV orgs cannot enable external MCP."));
                  return;
                }
                patch.mutate({ mcpEnabled: v });
              }}
              aria-label="Toggle external MCP"
            />
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
