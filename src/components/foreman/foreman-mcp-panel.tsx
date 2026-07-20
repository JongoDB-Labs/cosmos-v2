"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { Badge } from "@/components/ui/badge";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { useOrgQueryKey } from "@/lib/query/keys";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { notifyError } from "@/lib/errors/notify";

/**
 * Foreman MCP servers manager — add/manage remote (http/https ONLY) MCP
 * servers the build agent can use. Mirrors ForemanSkillsPanel's fetch/save
 * idioms: GET the list on mount, mutate via direct jsonFetch calls (no
 * react-query mutations, thin), refetch after. A server with `orgId: null`
 * is project-wide (wired into every org's builds); one with `orgId` is
 * scoped to this org only. Headers (e.g. an API token) are sealed
 * server-side and never round-trip back to this panel.
 */
interface McpServerRow {
  id: string;
  orgId: string | null;
  name: string;
  url: string;
  enabled: boolean;
}

const HTTP_URL_RE = /^https?:\/\//i;

export function ForemanMcpPanel({ orgId }: { orgId: string }) {
  return (
    <SectionCard
      icon={Plug}
      title="MCP servers"
      description="Remote MCP servers the build agent can use. Project servers apply to every build; org servers add to them."
    >
      <ForemanMcpBody orgId={orgId} />
    </SectionCard>
  );
}

function ForemanMcpBody({ orgId }: { orgId: string }) {
  const queryKey = useOrgQueryKey("foreman-mcp-servers");
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => jsonFetch<{ servers: McpServerRow[] }>(`/api/v1/orgs/${orgId}/foreman/mcp-servers`),
  });
  const qc = useQueryClient();

  const [orgScope, setOrgScope] = useState(true);
  const [createName, setCreateName] = useState("");
  const [createUrl, setCreateUrl] = useState("");
  const [createHeaders, setCreateHeaders] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  if (isLoading) return <Skeleton className="h-48 w-full" />;
  if (isError || !data) {
    return <LoadError title="Couldn't load MCP servers" onRetry={() => refetch()} />;
  }

  // Defensive: tolerate a fetch that resolves to a shape without `servers`
  // (e.g. a differently-shaped payload mid-refetch) rather than crashing the
  // whole console.
  const servers = data.servers ?? [];

  function withPending<T>(id: string, fn: () => Promise<T>): Promise<T> {
    setPendingIds((prev) => new Set(prev).add(id));
    return fn().finally(() => {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    });
  }

  async function toggleEnabled(server: McpServerRow) {
    try {
      await withPending(server.id, () =>
        jsonFetch(`/api/v1/orgs/${orgId}/foreman/mcp-servers/${server.id}`, {
          method: "PATCH",
          body: JSON.stringify({ enabled: !server.enabled }),
        }),
      );
      await refetch();
    } catch (err) {
      notifyError(err, "Couldn't update the MCP server.");
    }
  }

  async function deleteServer(server: McpServerRow) {
    try {
      await withPending(server.id, () =>
        jsonFetch(`/api/v1/orgs/${orgId}/foreman/mcp-servers/${server.id}`, { method: "DELETE" }),
      );
      toast.success(`Deleted "${server.name}".`);
      await refetch();
    } catch (err) {
      notifyError(err, "Couldn't delete the MCP server.");
    }
  }

  async function createServer() {
    if (!createName.trim() || !createUrl.trim()) return;
    if (!HTTP_URL_RE.test(createUrl.trim())) {
      setCreateError("Only remote http(s) MCP servers are allowed — no local commands.");
      return;
    }
    let headers: Record<string, string> | undefined;
    if (createHeaders.trim()) {
      try {
        const parsed: unknown = JSON.parse(createHeaders);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("not an object");
        }
        headers = parsed as Record<string, string>;
      } catch {
        setCreateError("Headers must be valid JSON, e.g. {\"Authorization\": \"Bearer …\"}");
        return;
      }
    }
    setCreateError(null);
    setCreating(true);
    try {
      await jsonFetch(`/api/v1/orgs/${orgId}/foreman/mcp-servers`, {
        method: "POST",
        body: JSON.stringify({
          name: createName,
          url: createUrl,
          ...(headers ? { headers } : {}),
          orgScope,
        }),
      });
      toast.success("MCP server added.");
      setCreateName("");
      setCreateUrl("");
      setCreateHeaders("");
      qc.invalidateQueries({ queryKey });
      await refetch();
    } catch (err) {
      notifyError(err, "Couldn't add the MCP server.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        {servers.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">No MCP servers yet.</p>
        ) : (
          servers.map((server) => (
            <div
              key={server.id}
              className="flex items-start justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-[var(--text)]">{server.name}</span>
                  <Badge variant="neutral" showDot={false}>
                    {server.orgId === null ? "Project" : "Org"}
                  </Badge>
                </div>
                <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">{server.url}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <ToggleSwitch
                  checked={server.enabled}
                  onCheckedChange={() => toggleEnabled(server)}
                  disabled={pendingIds.has(server.id)}
                  aria-label={`Enable ${server.name}`}
                />
                <ConfirmButton
                  onConfirm={() => deleteServer(server)}
                  pending={pendingIds.has(server.id)}
                  size="sm"
                  variant="ghost"
                >
                  Delete
                </ConfirmButton>
              </div>
            </div>
          ))
        )}
      </div>

      <div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-[var(--text)]">
          <Checkbox checked={orgScope} onChange={(e) => setOrgScope(e.target.checked)} />
          Apply to this org only
        </label>
        <p className="ml-6 text-xs text-[var(--text-muted)]">
          Checked: the server applies to this org&apos;s builds only. Unchecked: it becomes a
          project server, applying to every org&apos;s builds.
        </p>
      </div>

      <div className="rounded-lg border border-[var(--border)] p-3">
        <h4 className="mb-2 text-xs font-medium text-[var(--text-muted)]">Add an MCP server</h4>
        <div className="space-y-2">
          <Input
            aria-label="MCP server name"
            placeholder="Name"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
          />
          <Input
            aria-label="MCP server URL"
            placeholder="https://…"
            value={createUrl}
            onChange={(e) => setCreateUrl(e.target.value)}
          />
          <Textarea
            aria-label="MCP server headers"
            placeholder={'Optional headers as JSON, e.g. {"Authorization": "Bearer …"}'}
            value={createHeaders}
            onChange={(e) => setCreateHeaders(e.target.value)}
            rows={3}
          />
          {createError && <p className="text-xs text-destructive">{createError}</p>}
          <p className="text-xs text-[var(--text-muted)]">
            Only remote http(s) MCP servers (no local commands). Headers (e.g. an API token) are
            encrypted and never shown again.
          </p>
          <Button onClick={createServer} disabled={creating} size="sm">
            {creating ? "Adding…" : "Add"}
          </Button>
        </div>
      </div>
    </div>
  );
}
