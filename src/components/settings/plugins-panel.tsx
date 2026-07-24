"use client";

import { createElement, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Blocks, ChevronDown, ChevronRight, type LucideIcon } from "lucide-react";
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
import { PluginRegistry } from "@/lib/plugins/registry";
import "@/lib/plugins/registry/index";

/**
 * Settings → Plugins panel (ADR 0003) — THIN client surface over
 * GET /api/v1/orgs/[orgId]/plugins and PATCH /api/v1/orgs/[orgId]/plugins/[slug].
 * Sector compatibility and config validation are enforced SERVER-SIDE; the UI just
 * disables what the server would reject. Icons resolve client-side from the
 * client-safe manifest registry (they aren't serializable through the API).
 */

interface PluginConfigField {
  key: string;
  label: string;
  type: "text" | "url" | "number" | "boolean" | "select";
  required: boolean;
  options?: string[];
  help?: string;
}

interface PluginRow {
  slug: string;
  name: string;
  description: string;
  version: string;
  minCosmosVersion: string | null;
  sectors: string[];
  modules: { key: string; label: string }[];
  configFields: PluginConfigField[];
  recommendedSkinId: string | null;
  sectorCompatible: boolean;
  enabled: boolean;
  config: Record<string, unknown>;
  enabledAt: string | null;
  enabledVersion: string | null;
}

function pluginIcon(slug: string): LucideIcon {
  return PluginRegistry.get(slug)?.icon ?? Blocks;
}

export function PluginsPanel({ orgId }: { orgId: string }) {
  const queryKey = useOrgQueryKey("plugins");
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    queryFn: () => jsonFetch<{ plugins: PluginRow[] }>(`/api/v1/orgs/${orgId}/plugins`),
  });

  const patch = useOrgMutation({
    mutationFn: ({ slug, body }: { slug: string; body: { enabled?: boolean; config?: Record<string, unknown> } }) =>
      jsonFetch(`/api/v1/orgs/${orgId}/plugins/${slug}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    invalidate: [["plugins"]],
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (isError || !data) {
    return <LoadError title="Couldn't load plugins" onRetry={() => refetch()} />;
  }

  const enabled = data.plugins.filter((p) => p.enabled);
  const available = data.plugins.filter((p) => !p.enabled && p.sectorCompatible);
  const unavailable = data.plugins.filter((p) => !p.enabled && !p.sectorCompatible);

  const groups: { label: string; description: string; rows: PluginRow[] }[] = [
    { label: "Enabled", description: "Active for this organization.", rows: enabled },
    { label: "Available", description: "Compatible with this organization — off until enabled.", rows: available },
    {
      label: "Unavailable",
      description: "Requires an industry sector this organization doesn't have enabled.",
      rows: unavailable,
    },
  ];

  return (
    <div className="space-y-6">
      {groups
        .filter((g) => g.rows.length > 0)
        .map((g) => (
          <SectionCard key={g.label} icon={Blocks} title={g.label} description={g.description}>
            <div className="space-y-4">
              {g.rows.map((p) => (
                <PluginCard
                  key={p.slug}
                  plugin={p}
                  pending={patch.isPending}
                  onToggle={(next) =>
                    patch.mutate(
                      { slug: p.slug, body: { enabled: next } },
                      { onError: (e) => notifyError(e, "Couldn't update plugin") },
                    )
                  }
                  onSaveConfig={(config) =>
                    patch.mutate(
                      { slug: p.slug, body: { config } },
                      { onError: (e) => notifyError(e, "Couldn't save plugin config") },
                    )
                  }
                />
              ))}
            </div>
          </SectionCard>
        ))}
      {data.plugins.length === 0 && (
        <SectionCard icon={Blocks} title="No plugins" description="This deployment has no plugins registered.">
          <span className="text-sm text-[var(--text-muted)]">Nothing to configure.</span>
        </SectionCard>
      )}
      <p className="text-xs text-[var(--text-muted)]">
        Enabling, disabling, and configuring plugins is recorded in the audit log. Disabling a
        plugin hides its surfaces but keeps its data — re-enabling restores everything.
      </p>
    </div>
  );
}

function PluginCard({
  plugin,
  pending,
  onToggle,
  onSaveConfig,
}: {
  plugin: PluginRow;
  pending: boolean;
  onToggle: (next: boolean) => void;
  onSaveConfig: (config: Record<string, unknown>) => void;
}) {
  const [showConfig, setShowConfig] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>(plugin.config);
  // Re-hydrate the local draft when the server config changes (a refetch after a
  // save/normalize, or another admin's concurrent edit) — the card keeps a stable
  // key across refetches so it never remounts. Mirrors feedback-automation-form.tsx
  // (same sanctioned re-seed-on-server-change pattern + disable).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setDraft(plugin.config), [plugin.config]);
  const toggleable = plugin.enabled || plugin.sectorCompatible;

  return (
    <div className="rounded-lg border border-[var(--border)] p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          {createElement(pluginIcon(plugin.slug), {
            className: "mt-0.5 h-5 w-5 shrink-0 text-[var(--text-muted)]",
          })}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{plugin.name}</span>
              <Badge variant="neutral" showDot={false}>v{plugin.version}</Badge>
              {plugin.sectors.map((s) => (
                <Badge key={s} variant="strategic" showDot={false}>
                  {s}
                </Badge>
              ))}
            </div>
            <p className="mt-1 text-sm text-[var(--text-muted)]">{plugin.description}</p>
            {plugin.modules.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-[var(--text-muted)]">Adds:</span>
                {plugin.modules.map((m) => (
                  <Badge key={m.key} variant="discovery" showDot={false}>
                    {m.label}
                  </Badge>
                ))}
              </div>
            )}
            {!plugin.sectorCompatible && !plugin.enabled && (
              <p className="mt-2 text-xs text-[var(--warning,#b45309)]">
                Requires the {plugin.sectors.join(" / ")} sector.
              </p>
            )}
          </div>
        </div>
        <ToggleSwitch
          checked={plugin.enabled}
          disabled={pending || !toggleable}
          onCheckedChange={(next: boolean) => onToggle(next)}
          aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.name}`}
        />
      </div>

      {plugin.enabled && plugin.configFields.length > 0 && (
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <button
            type="button"
            className="flex items-center gap-1 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text)]"
            onClick={() => setShowConfig((s) => !s)}
          >
            {showConfig ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            Configure
          </button>
          {showConfig && (
            <div className="mt-3 space-y-3">
              {plugin.configFields.map((f) => (
                <ConfigField
                  key={f.key}
                  field={f}
                  value={draft[f.key]}
                  onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
                />
              ))}
              <Button size="sm" disabled={pending} onClick={() => onSaveConfig(draft)}>
                Save configuration
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ConfigField({
  field,
  value,
  onChange,
}: {
  field: PluginConfigField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const id = `plugin-config-${field.key}`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium">
        {field.label}
        {field.required && <span className="text-[var(--critical,#b91c1c)]"> *</span>}
      </label>
      {field.type === "boolean" ? (
        <ToggleSwitch
          checked={value === true}
          onCheckedChange={(next: boolean) => onChange(next)}
          aria-label={field.label}
        />
      ) : field.type === "select" ? (
        <select
          id={id}
          className="h-8 rounded-md border border-[var(--border)] bg-transparent px-2 text-sm"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value || undefined)}
        >
          <option value="">—</option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          type={field.type === "number" ? "number" : "text"}
          className="h-8 rounded-md border border-[var(--border)] bg-transparent px-2 text-sm"
          value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
          onChange={(e) =>
            onChange(
              field.type === "number"
                ? e.target.value === ""
                  ? undefined
                  : Number(e.target.value)
                : e.target.value || undefined,
            )
          }
        />
      )}
      {field.help && <span className="text-xs text-[var(--text-muted)]">{field.help}</span>}
    </div>
  );
}
