"use client";

import { useQuery } from "@tanstack/react-query";
import { jsonFetch } from "@/lib/query/json-fetcher";

interface CurrentUser {
  id: string;
  email: string;
  displayName: string | null;
}

/**
 * The signed-in user, cached process-wide (the identity doesn't change within a
 * session). Used by client surfaces that need "me" without threading the id
 * down through every server component — e.g. the board "Assigned to me" filter.
 */
export function useCurrentUser() {
  return useQuery({
    queryKey: ["current-user"],
    queryFn: () => jsonFetch<CurrentUser>("/api/v1/me"),
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
}

/** Convenience: just the current user's id (null until loaded). */
export function useCurrentUserId(): string | null {
  return useCurrentUser().data?.id ?? null;
}
