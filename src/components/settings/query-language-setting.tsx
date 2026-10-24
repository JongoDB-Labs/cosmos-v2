"use client";

import { useQuery } from "@tanstack/react-query";
import { TextSearch } from "lucide-react";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { SectionCard } from "@/components/ui/section-card";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import { notifyError } from "@/lib/errors/notify";

/**
 * The org switch for the query language beta: Issues gets the Basic / Advanced
 * query bar (chips, and CQL with completion) in place of the filter dropdowns.
 * Shown to admins who can change org settings.
 */
export function QueryLanguageOrgSwitch({ orgId }: { orgId: string }) {
  const { data } = useQuery({
    queryKey: useOrgQueryKey("query-language"),
    queryFn: () => jsonFetch<{ enabled: boolean; canManage: boolean }>(`/api/v1/orgs/${orgId}/query-language`),
  });
  const toggle = useOrgMutation({
    mutationFn: (enabled: boolean) =>
      jsonFetch(`/api/v1/orgs/${orgId}/query-language`, { method: "PUT", body: JSON.stringify({ enabled }) }),
    // The Issues view reads the flag through the schema.
    invalidate: [["query-language"], ["cql-schema"]],
    onError: (e) => notifyError(e, "Couldn't change the setting."),
  });
  if (!data?.canManage) return null;
  return (
    <SectionCard
      icon={TextSearch}
      title="Query language (beta)"
      description="Filter Issues with chips or a query language, e.g. assignee = me AND priority IN (HIGH, CRITICAL)."
    >
      <label className="flex items-start justify-between gap-4 text-sm">
        <span>
          Turn on the query language
          <span className="mt-0.5 block text-xs text-muted-foreground">
            Replaces the filter dropdowns on Issues with Basic (chips) and Advanced (typed queries with
            completion). Links with a query keep working only while it is on.
          </span>
        </span>
        <ToggleSwitch
          aria-label="Query language (beta)"
          checked={data.enabled}
          onCheckedChange={(v) => toggle.mutate(v)}
          disabled={toggle.isPending}
        />
      </label>
    </SectionCard>
  );
}
