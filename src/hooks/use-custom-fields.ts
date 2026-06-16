"use client";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useOrgQueryKey } from "@/lib/query/keys";
import type { CustomField } from "@/types/models";

/**
 * Load the custom-field DEFINITIONS that apply to a given project.
 *
 * The defs API (`GET /api/v1/orgs/[orgId]/custom-fields`) returns every field
 * in the org; a field with `projectId === null` is org-wide, otherwise it is
 * scoped to a single project. We fetch the whole org list once (cheap, cached
 * via React Query) and narrow to "this project OR org-wide" on the client, so
 * switching projects doesn't refetch. Results are sorted by `sortOrder` to
 * mirror the admin's intended display order.
 *
 * The query key flows through `useOrgQueryKey` so an org switch serves a
 * different cache namespace (multi-tenant cache isolation).
 */
export function useCustomFields(orgId: string, projectId: string | undefined) {
  const key = useOrgQueryKey("custom-fields");
  const query = useQuery({
    queryKey: key,
    queryFn: async (): Promise<CustomField[]> => {
      const res = await fetch(`/api/v1/orgs/${orgId}/custom-fields`);
      if (!res.ok) throw new Error("Failed to load custom fields");
      const json = await res.json();
      const list: CustomField[] = Array.isArray(json) ? json : json.data ?? [];
      return list;
    },
    staleTime: 60_000,
  });

  const fields = useMemo(() => {
    const all = query.data ?? [];
    return all
      .filter((f) => f.projectId == null || f.projectId === projectId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }, [query.data, projectId]);

  return { ...query, fields };
}

/**
 * Whether a field should render for an item of `workItemTypeId`, honoring the
 * field's type bindings: a field with NO bindings shows for every type; a field
 * WITH bindings only shows when the item's type is among them.
 */
export function fieldAppliesToType(
  field: CustomField,
  workItemTypeId: string | null | undefined,
): boolean {
  const bindings = field.typeBindings ?? [];
  if (bindings.length === 0) return true;
  if (!workItemTypeId) return false;
  return bindings.some((b) => b.workItemTypeId === workItemTypeId);
}
