"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

export function QueryProvider({ children }: { children: React.ReactNode }) {
  // Use useState so the QueryClient is stable across renders but unique per
  // user session. Re-creating it would lose cache. SSR-safe.
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000, // 30s — sensible default for most dashboard data
            gcTime: 5 * 60_000, // 5 min — keep in memory for back-nav
            retry: 1, // be cheap on retries
            refetchOnWindowFocus: false, // don't thrash on tab switches
          },
          mutations: {
            retry: 0,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
