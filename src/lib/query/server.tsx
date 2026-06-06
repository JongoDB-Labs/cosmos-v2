import {
  QueryClient,
  dehydrate,
  HydrationBoundary,
  type DehydratedState,
} from "@tanstack/react-query";

/**
 * Create a fresh server-side QueryClient with the same defaults as the
 * client. Each request gets its own client — never share across requests.
 *
 * Usage in a server page:
 *
 *   const qc = makeServerQueryClient();
 *   await qc.prefetchQuery({ queryKey: [...], queryFn: async () => {...} });
 *   return (
 *     <HydrationBoundary state={dehydrate(qc)}>
 *       <SomeClientComponent />
 *     </HydrationBoundary>
 *   );
 *
 * The client component must use the same `queryKey` so that its `useQuery`
 * call reads the prefetched data from the cache on first render instead of
 * triggering a fresh fetch.
 */
export function makeServerQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });
}

export { dehydrate, HydrationBoundary };
export type { DehydratedState };
