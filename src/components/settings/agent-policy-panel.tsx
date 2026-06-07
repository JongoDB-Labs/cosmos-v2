"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Ban, Layers, SlidersHorizontal, ListChecks } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { jsonFetch } from "@/lib/query/json-fetcher";

/**
 * Agent Policy (design D9/§8) — THIN client surface. The API is the source of truth: this
 * panel GET/PATCHes /api/v1/orgs/[orgId]/agent-policy for the 3 axes (tools, domain, args).
 * The ABSENCE of a policy ⇒ PERMISSIVE (everything runs) — the load-bearing default; the
 * controls here just narrow it. Validation (domains ∈ the known set, maxResultLimit ≥ 1) is
 * enforced SERVER-SIDE; the UI mirrors the known-domain set the GET returns.
 */

interface AgentPolicyResponse {
  knownDomains: string[];
  allowedTools: string[] | null; // null = all tools allowed
  deniedTools: string[];
  deniedDomains: string[];
  maxResultLimit: number | null; // null = no clamp
  allowedProjectIds: string[] | null; // null = any project
}

type PatchBody = Partial<Pick<AgentPolicyResponse, "allowedTools" | "deniedTools" | "deniedDomains" | "maxResultLimit" | "allowedProjectIds">>;

/** Split a textarea (newline/comma separated) into a clean string[]. */
function parseList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function AgentPolicyPanel({ orgId }: { orgId: string }) {
  const queryKey = useOrgQueryKey("agent-policy");
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => jsonFetch<AgentPolicyResponse>(`/api/v1/orgs/${orgId}/agent-policy`),
  });

  const patch = useOrgMutation({
    mutationFn: (body: PatchBody) =>
      jsonFetch<AgentPolicyResponse>(`/api/v1/orgs/${orgId}/agent-policy`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    invalidate: [["agent-policy"]],
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (isError || !data) {
    return <LoadError title="Couldn't load agent policy" onRetry={() => refetch()} />;
  }

  return <PanelBody data={data} disabled={patch.isPending} onPatch={(b) => patch.mutate(b)} />;
}

function PanelBody({
  data,
  disabled,
  onPatch,
}: {
  data: AgentPolicyResponse;
  disabled: boolean;
  onPatch: (body: PatchBody) => void;
}) {
  // Local text buffers for the list editors (committed on blur). Domains are toggles, so they
  // patch immediately.
  const [deniedTools, setDeniedTools] = useState(data.deniedTools.join("\n"));
  const [allowedToolsOn, setAllowedToolsOn] = useState(data.allowedTools !== null);
  const [allowedTools, setAllowedTools] = useState((data.allowedTools ?? []).join("\n"));
  const [limitOn, setLimitOn] = useState(data.maxResultLimit !== null);
  const [limit, setLimit] = useState(data.maxResultLimit?.toString() ?? "20");
  const [projectsOn, setProjectsOn] = useState(data.allowedProjectIds !== null);
  const [projects, setProjects] = useState((data.allowedProjectIds ?? []).join("\n"));

  function toggleDomain(domain: string, denied: boolean) {
    const set = new Set(data.deniedDomains);
    if (denied) set.add(domain);
    else set.delete(domain);
    onPatch({ deniedDomains: [...set] });
  }

  return (
    <div className="space-y-6">
      {/* AXIS 1 — tools. */}
      <SectionCard
        icon={Ban}
        title="Denied tools"
        description="Tool names the agent may never call (a denylist — always wins). One per line."
      >
        <Textarea
          value={deniedTools}
          disabled={disabled}
          rows={3}
          placeholder="fetch_url&#10;send_email"
          onChange={(e) => setDeniedTools(e.target.value)}
          onBlur={() => onPatch({ deniedTools: parseList(deniedTools) })}
          aria-label="Denied tools"
        />
      </SectionCard>

      <SectionCard
        icon={ListChecks}
        title="Tool allowlist"
        description="When on, ONLY the listed tools may run (everything else is blocked). Off means all tools are allowed (subject to the denylist + denied domains)."
      >
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Restrict to an allowlist</span>
            <ToggleSwitch
              checked={allowedToolsOn}
              disabled={disabled}
              onCheckedChange={(v) => {
                setAllowedToolsOn(v);
                // Off ⇒ clear the allowlist (null = all allowed). On ⇒ apply the current buffer.
                onPatch({ allowedTools: v ? parseList(allowedTools) : null });
              }}
              aria-label="Restrict to a tool allowlist"
            />
          </div>
          {allowedToolsOn ? (
            <Textarea
              value={allowedTools}
              disabled={disabled}
              rows={4}
              placeholder="query_work_items&#10;create_work_item"
              onChange={(e) => setAllowedTools(e.target.value)}
              onBlur={() => onPatch({ allowedTools: parseList(allowedTools) })}
              aria-label="Allowed tools"
            />
          ) : null}
        </div>
      </SectionCard>

      {/* AXIS 2 — data domains. */}
      <SectionCard
        icon={Layers}
        title="Denied data domains"
        description="Block every tool in a coarse data domain (e.g. deny finance to keep the agent out of revenue/expense tools)."
      >
        <div className="grid grid-cols-2 gap-x-6 sm:grid-cols-3">
          {data.knownDomains.map((domain) => (
            <div key={domain} className="flex items-center justify-between py-2">
              <span className="text-sm">{domain}</span>
              <ToggleSwitch
                checked={data.deniedDomains.includes(domain)}
                disabled={disabled}
                onCheckedChange={(v) => toggleDomain(domain, v)}
                aria-label={`Deny ${domain} domain`}
              />
            </div>
          ))}
        </div>
      </SectionCard>

      {/* AXIS 3 — arg constraints. */}
      <SectionCard
        icon={SlidersHorizontal}
        title="Result limit cap"
        description="When on, a tool's limit / maxResults argument above the cap is clamped down (the tool still runs)."
      >
        <div className="flex items-center gap-4">
          <ToggleSwitch
            checked={limitOn}
            disabled={disabled}
            onCheckedChange={(v) => {
              setLimitOn(v);
              onPatch({ maxResultLimit: v ? Math.max(1, parseInt(limit, 10) || 1) : null });
            }}
            aria-label="Enable a result-limit cap"
          />
          {limitOn ? (
            <Input
              type="number"
              min={1}
              value={limit}
              disabled={disabled}
              className="w-28"
              onChange={(e) => setLimit(e.target.value)}
              onBlur={() => onPatch({ maxResultLimit: Math.max(1, parseInt(limit, 10) || 1) })}
              aria-label="Maximum result limit"
            />
          ) : (
            <span className="text-sm text-[var(--text-muted)]">No cap</span>
          )}
        </div>
      </SectionCard>

      <SectionCard
        icon={ListChecks}
        title="Project scope allowlist"
        description="When on, a tool call carrying a projectId outside this list is refused. Off means any project is allowed. One project ID per line."
      >
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Restrict to allowed projects</span>
            <ToggleSwitch
              checked={projectsOn}
              disabled={disabled}
              onCheckedChange={(v) => {
                setProjectsOn(v);
                onPatch({ allowedProjectIds: v ? parseList(projects) : null });
              }}
              aria-label="Restrict to allowed projects"
            />
          </div>
          {projectsOn ? (
            <Textarea
              value={projects}
              disabled={disabled}
              rows={3}
              placeholder="proj_abc123"
              onChange={(e) => setProjects(e.target.value)}
              onBlur={() => onPatch({ allowedProjectIds: parseList(projects) })}
              aria-label="Allowed project IDs"
            />
          ) : null}
        </div>
      </SectionCard>
    </div>
  );
}
