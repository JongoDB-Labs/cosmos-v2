"use client";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { bareTypeKey } from "@/components/boards/shared/filter-bar";

/**
 * A work-item type as returned by `GET /api/v1/orgs/[orgId]/work-item-types` —
 * the org's built-in types (rows where `orgId IS NULL`) PLUS this org's custom
 * types. Keys are sector-prefixed for built-ins (`software.task`,
 * `software.epic`) but custom types may be bare (`feature`).
 */
export interface WorkItemTypeRow {
  id: string;
  key: string;
  name: string;
  pluralName?: string | null;
  icon?: string | null;
  color?: string | null;
  isBuiltIn: boolean;
  sortOrder: number;
}

/**
 * The bare uppercase type keys the board Type filter (and the type color maps)
 * match on, used as the fallback when the types API is still loading/empty.
 * Mirrors the legacy hardcoded `WORK_ITEM_TYPES` so the filter never renders
 * blank before the org's real types arrive.
 */
const FALLBACK_BARE_KEYS = ["EPIC", "STORY", "TASK", "BUG", "SUBTASK"] as const;

/**
 * Load the org's ACTUAL work-item types so every type filter / create picker
 * reflects custom org types (e.g. a "Feature" type) alongside the built-ins —
 * instead of a hardcoded `["TASK","STORY","BUG","EPIC","SUBTASK"]` list that
 * silently drops anything custom.
 *
 * Returns the raw `types` (for create pickers — each option's label is `name`
 * and its value resolves to a `workItemTypeId`) plus `bareKeys`: the unique
 * `bareTypeKey(t.key)` values in `sortOrder` order, which the board Type filter
 * keys off. Falls back to the built-in five while loading/empty.
 *
 * The query key flows through `useOrgQueryKey` so an org switch serves a
 * different cache namespace (multi-tenant cache isolation).
 */
/**
 * Work-item types that SHADOW a real table.
 *
 * Each of these names an entity that already exists in its own right — Goal,
 * KeyResult, Kpi, Milestone, Objective and Risk are all Prisma models with
 * their own boards and APIs. Having them as work-item types too meant one word
 * described two unrelated rows: a "Milestone" created from a New issue dialog
 * is a WorkItem and never appears on the Milestones board, which is exactly
 * what got reported.
 *
 * They are hidden from CREATE pickers rather than deleted. Existing items keep
 * their type, stay visible, and can be retyped to something else — see
 * `selectableTypes`. Nothing is lost and the decision stays reversible.
 *
 * NOT only the `cross.*` namespace. This list was originally written as "the
 * cross-cutting types", which is what let `consulting.milestone_item` — seeded
 * as name "Milestone", pluralName "Milestones", the same Flag icon — slip
 * through and keep offering a second, duplicate Milestone in every Client
 * Engagement project. What qualifies a key is that its NAME collides with a
 * real model, whatever namespace it lives in; `shadowed-types.test.ts` asserts
 * that against the seeds so the next sector to add one fails a test instead of
 * shipping a duplicate.
 */
export const SHADOW_TYPE_KEYS = new Set([
  "cross.goal",
  "cross.milestone",
  "cross.kpi",
  "cross.objective",
  "cross.key_result",
  "cross.risk",
  "consulting.milestone_item",
]);

/**
 * Types offered in a picker.
 *
 * Drops the shadow types, but always keeps `currentTypeId` — an item already
 * filed as one has to render its own value, or the Select shows blank and the
 * user cannot even change it to something valid.
 */
export function selectableTypes<T extends { id: string; key: string }>(
  types: T[],
  currentTypeId?: string | null,
): T[] {
  return types.filter(
    (t) => !SHADOW_TYPE_KEYS.has(t.key) || t.id === currentTypeId,
  );
}

export function useWorkItemTypes(orgId: string) {
  const key = useOrgQueryKey("work-item-types");
  const query = useQuery({
    queryKey: key,
    queryFn: () =>
      jsonFetch<WorkItemTypeRow[]>(`/api/v1/orgs/${orgId}/work-item-types`),
    staleTime: 60_000,
  });

  const types = useMemo(() => query.data ?? [], [query.data]);

  // Unique bare keys, preserving the API's sortOrder (built-ins first). Falls
  // back to the built-in five so the Type filter is never empty mid-load.
  const bareKeys = useMemo(() => {
    if (types.length === 0) return [...FALLBACK_BARE_KEYS];
    const seen = new Set<string>();
    const keys: string[] = [];
    for (const t of types) {
      const bare = bareTypeKey(t.key);
      if (bare && !seen.has(bare)) {
        seen.add(bare);
        keys.push(bare);
      }
    }
    return keys.length > 0 ? keys : [...FALLBACK_BARE_KEYS];
  }, [types]);

  return { ...query, types, bareKeys };
}
