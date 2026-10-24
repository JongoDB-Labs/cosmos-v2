"use client";

/**
 * Saved filters (query phase 3) on the client: the list, one filter as this
 * viewer may see it, the writes, and "recently used" (this browser only).
 * Every key flows through useOrgQueryKey; writes invalidate ["saved-views"],
 * the key the legacy picker used, so both stay in step.
 */
import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import { useOrgMutation } from "@/lib/query/use-org-mutation";
import type { SavedFilterDto } from "@/lib/query/saved-filter-dto.server";
import type { Presented } from "@/lib/query/saved-filters.server";

export type SavedFilter = SavedFilterDto;
export type SavedFilterDetail = SavedFilterDto & Presented;
export type Visibility = SavedFilterDto["visibility"];

export interface SavedFilterInput {
  name?: string;
  description?: string;
  cql?: string;
  visibility?: Visibility;
  projectId?: string | null;
  teamId?: string | null;
  editorIds?: string[];
}

export function useSavedFilters(orgId: string, enabled = true) {
  return useQuery({
    queryKey: useOrgQueryKey("saved-views"),
    queryFn: () => jsonFetch<SavedFilter[]>(`/api/v1/orgs/${orgId}/saved-views`),
    staleTime: 30_000,
    enabled,
  });
}

export function useSavedFilter(orgId: string, id: string | null) {
  return useQuery({
    queryKey: useOrgQueryKey("saved-views", id ?? "none"),
    queryFn: () => jsonFetch<SavedFilterDetail>(`/api/v1/orgs/${orgId}/saved-views/${id}`),
    enabled: !!id,
    staleTime: 30_000,
    retry: false,
  });
}

export function useSavedFilterMutations(orgId: string) {
  const base = `/api/v1/orgs/${orgId}/saved-views`;
  const invalidate = [["saved-views"]];
  const create = useOrgMutation<SavedFilter, Error, SavedFilterInput & { name: string }>({
    mutationFn: (body) => jsonFetch(base, { method: "POST", body: JSON.stringify(body) }),
    invalidate,
    onError: () => {},
  });
  const update = useOrgMutation<SavedFilter, Error, { id: string } & SavedFilterInput>({
    mutationFn: ({ id, ...body }) => jsonFetch(`${base}/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    invalidate,
    onError: () => {},
  });
  const remove = useOrgMutation<unknown, Error, string>({
    mutationFn: (id) => jsonFetch(`${base}/${id}`, { method: "DELETE" }),
    invalidate,
  });
  const star = useOrgMutation<unknown, Error, { id: string; on: boolean }>({
    mutationFn: ({ id, on }) => jsonFetch(`${base}/${id}/favorite`, { method: on ? "PUT" : "DELETE", ...(on ? { body: "{}" } : {}) }),
    invalidate,
  });
  return { create, update, remove, star };
}

// ── recently used (per browser) ──────────────────────────────────────────────

const RECENT_KEY = "cosmos:issues:recent-filters";

export function recentFilterIds(): string[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 5) : [];
  } catch {
    return [];
  }
}

export function rememberFilter(id: string) {
  try {
    const next = [id, ...recentFilterIds().filter((x) => x !== id)].slice(0, 5);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* private window: no recents */
  }
}

/** The server's reason for a failed write: `{error: "…"}` or a CQL `{error: {diagnostics}}`. */
export function apiErrorText(e: unknown, fallback: string): string {
  const body = (e as { body?: { error?: unknown } } | null)?.body;
  const err = body?.error;
  if (typeof err === "string") return err;
  const first = (err as { diagnostics?: { message?: string }[] } | undefined)?.diagnostics?.[0]?.message;
  if (first) return first;
  return e instanceof Error && e.message ? e.message : fallback;
}
