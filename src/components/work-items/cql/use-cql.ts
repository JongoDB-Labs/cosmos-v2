"use client";

/**
 * Client hooks for CQL on the Issues view.
 *
 *   useCqlSchema   what a query can say here (fields, custom fields,
 *                  functions); `enabled: false` when the org has CQL off,
 *                  so callers fall back to the legacy filter bar. It reads
 *                  the org's switch first and asks for the schema only when
 *                  it's on: the schema route 404s while CQL is off, and the
 *                  browser logs that 404 on every page that asks.
 *   useCqlUrlState the query lives in the URL (`?cql=`, `&mode=`), so a
 *                  filtered list is shareable and survives a reload. Other
 *                  params (`?item=` deep links) are left alone.
 */
import { useCallback, useMemo } from "react";
import { useSearchParams, usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { jsonFetch, FetchError } from "@/lib/query/json-fetcher";
import { useOrgQueryKey } from "@/lib/query/keys";
import type { FieldDef } from "@/lib/query/fields";
import type { FunctionDef } from "@/lib/query/functions";
import type { SchemaCustomField } from "@/lib/query/typecheck";
import type { CqlQuery } from "@/lib/query/ast";
import type { CqlDiagnostic } from "@/lib/query/errors";

export interface CqlClientSchema {
  version: 1;
  fields: (Omit<FieldDef, "sortable" | "groupable"> & { sortable: boolean; groupable: boolean })[];
  customFields: SchemaCustomField[];
  functions: FunctionDef[];
}

export function useCqlSchema(orgId: string): { enabled: boolean; schema: CqlClientSchema | null; isLoading: boolean } {
  // The same query (and cache entry) as the org settings card, so turning CQL
  // on or off there refreshes this too.
  const flag = useQuery({
    queryKey: useOrgQueryKey("query-language"),
    queryFn: () => jsonFetch<{ enabled: boolean; canManage: boolean }>(`/api/v1/orgs/${orgId}/query-language`),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const on = flag.data?.enabled === true;
  const q = useQuery({
    queryKey: useOrgQueryKey("cql-schema"),
    queryFn: async () => {
      try {
        return await jsonFetch<CqlClientSchema>(`/api/v1/orgs/${orgId}/cql/schema`);
      } catch (e) {
        // Switched off since the flag was read: not an error, just the legacy bar.
        if (e instanceof FetchError && e.status === 404) return null;
        throw e;
      }
    },
    enabled: on,
    staleTime: 5 * 60_000,
    retry: false,
  });
  // Only a real schema switches CQL on; anything else is the legacy bar.
  const schema = on && q.data && q.data.version === 1 && Array.isArray(q.data.fields) ? q.data : null;
  return { enabled: !!schema, schema, isLoading: flag.isLoading || (on && q.isLoading) };
}

export interface CqlValidation {
  valid: boolean;
  /** Resolved (refs carry ids): what saved views and "Save as board" store. */
  query?: CqlQuery;
  /** Canonical text. */
  cql?: string;
  diagnostics: CqlDiagnostic[];
}

/**
 * The server's verdict on the applied query: unknown or ambiguous values
 * (which only the server can resolve, scoped to what the viewer may read) and
 * the resolved query. Shared by the builder and the Issues view, one request.
 */
export function useCqlValidate(orgId: string, cql: string, enabled: boolean) {
  const key = useOrgQueryKey("cql-validate", cql);
  return useQuery({
    queryKey: key,
    queryFn: () =>
      jsonFetch<CqlValidation>(`/api/v1/orgs/${orgId}/cql/validate`, {
        method: "POST",
        body: JSON.stringify({ cql, mode: "warn", tz: viewerTimeZone() }),
      }),
    enabled: enabled && cql.trim() !== "",
    staleTime: 30_000,
    retry: false,
  });
}

export type QueryMode = "basic" | "advanced";

export function useCqlUrlState(): {
  cql: string;
  /** `?filter=<id>`: the saved filter loaded (run by id until the text changes). */
  filterId: string | null;
  mode: QueryMode | null;
  setMode: (mode: QueryMode) => void;
  /**
   * Any params, in ONE navigation. Two replaces in a row race: both build
   * their next params from the same `searchParams` snapshot (React has not
   * re-rendered inside the handler), so the second silently drops what the
   * first set. Setting the query and the mode together must come through here —
   * that pair, written separately, is how "Run as a query" lost the query.
   */
  update: (patch: Record<string, string | null>) => void;
} {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const cql = searchParams.get("cql") ?? "";
  const filterId = searchParams.get("filter");
  const modeParam = searchParams.get("mode");
  const mode: QueryMode | null = modeParam === "basic" || modeParam === "advanced" ? modeParam : null;

  const replace = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "") next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      // Shallow, through the History API (which the App Router syncs into
      // useSearchParams): the query is client state, read by IssuesView and by
      // nothing on the server. router.replace re-rendered the page on the
      // server first and changed the URL only when that returned, so under
      // load the query, and the results with it, lagged a running query by
      // seconds.
      window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
    },
    [pathname, searchParams],
  );

  return useMemo(
    () => ({
      cql,
      filterId,
      mode,
      setMode: (m: QueryMode) => replace({ mode: m }),
      update: replace,
    }),
    [cql, filterId, mode, replace],
  );
}

/** The viewer's zone, sent with every query so startOfWeek() means their week. */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
