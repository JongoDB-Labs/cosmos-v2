"use client";
/**
 * Client hooks shared by every @-mention surface.
 *   - `useEntitySearch`  — debounced typeahead against the shared entity index.
 *   - `useRefResolver`   — batch-resolve stored `<@type:id>` tokens to chip data.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { useOrgQueryKey } from "@/lib/query/keys";
import {
  parseRefs,
  refKey,
  type EntityRef,
  type EntityType,
  type ResolvedEntity,
} from "@/lib/mentions/refs";

export function useEntitySearch(
  orgId: string,
  query: string,
  types?: EntityType[],
) {
  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 180);
    return () => clearTimeout(t);
  }, [query]);

  const typesKey = types && types.length ? types.join(",") : "all";
  const key = useOrgQueryKey("mention-search", typesKey, debounced);

  return useQuery({
    queryKey: key,
    enabled: debounced.trim().length > 0,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<ResolvedEntity[]> => {
      const p = new URLSearchParams({ q: debounced });
      if (types && types.length) p.set("types", types.join(","));
      const r = await fetch(
        `/api/v1/orgs/${orgId}/mentions/search?${p.toString()}`,
      );
      // Rate-limited (one budget with ⌘K): not "no matches". Thrown, it isn't
      // cached; the last results stay up while React Query asks again.
      if (r.status === 429) throw new Error("Search is rate-limited");
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j) ? (j as ResolvedEntity[]) : [];
    },
  });
}

/**
 * Resolve the refs embedded in `contents` to `{label,url,…}` for chip render.
 * `seed` supplies instant hits the caller already has (e.g. chat users from the
 * member map) so those chips never flicker and aren't refetched.
 */
export function useRefResolver(
  orgId: string,
  contents: string[],
  seed?: Map<string, ResolvedEntity>,
): Map<string, ResolvedEntity> {
  const joined = contents.join("\u0000");
  const refs = useMemo<EntityRef[]>(() => {
    const seen = new Set<string>();
    const out: EntityRef[] = [];
    for (const c of contents) {
      for (const r of parseRefs(c)) {
        const k = refKey(r.type, r.id);
        if (!seen.has(k)) {
          seen.add(k);
          out.push(r);
        }
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined]);

  const toFetch = useMemo(
    () => refs.filter((r) => !(seed && seed.has(refKey(r.type, r.id)))),
    [refs, seed],
  );
  const fetchKey = useMemo(
    () =>
      toFetch
        .map((r) => refKey(r.type, r.id))
        .sort()
        .join("|"),
    [toFetch],
  );
  const key = useOrgQueryKey("mention-resolve", fetchKey);

  const { data } = useQuery({
    queryKey: key,
    enabled: toFetch.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<ResolvedEntity[]> => {
      const r = await fetch(`/api/v1/orgs/${orgId}/mentions/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refs: toFetch }),
      });
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j) ? (j as ResolvedEntity[]) : [];
    },
  });

  return useMemo(() => {
    const map = new Map<string, ResolvedEntity>(seed ? [...seed] : []);
    for (const e of data ?? []) map.set(refKey(e.type, e.id), e);
    return map;
  }, [data, seed]);
}
