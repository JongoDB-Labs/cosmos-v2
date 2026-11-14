// @vitest-environment jsdom
//
// The @-mention search route can now answer 429 (it shares the ⌘K palette's
// rate limit). The typeahead read any refusal as "no matches", and React
// Query kept that empty answer for its 30 s stale time, so a term typed while
// throttled showed nothing even once the limit had passed. A 429 now keeps the
// last results on screen and asks again; other refusals still read as none.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/acme/projects",
}));

import { useEntitySearch } from "./hooks";

const hit = (id: string) => ({ type: "workItem", id, label: id, url: `/acme/work-items?item=${id}` });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Answers per search term, in order; the last answer repeats. */
let answers: Record<string, Response[]> = {};
const fetchMock = vi.fn(async (url: string) => {
  const q = new URL(url, "http://localhost").searchParams.get("q") ?? "";
  const list = answers[q] ?? [json([])];
  return (list.length > 1 ? list.shift() : list[0])!.clone();
});

function wrapper({ children }: { children: ReactNode }) {
  // The app's own defaults (components/providers/query-provider.tsx): one retry.
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1 } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useEntitySearch when the search is refused", () => {
  it("a 429 keeps the last results and asks again, never showing an empty list", async () => {
    answers = { ro: [json([hit("first")])], roa: [json({ error: "rate_limited" }, 429), json([hit("second")])] };
    const seen: unknown[] = [];
    const { result, rerender } = renderHook(({ q }) => {
      const r = useEntitySearch("org-1", q);
      seen.push(r.data);
      return r;
    }, { wrapper, initialProps: { q: "ro" } });
    await waitFor(() => expect(result.current.data).toEqual([hit("first")]));

    rerender({ q: "roa" });
    await waitFor(() => expect(result.current.data).toEqual([hit("second")]), { timeout: 4000 });
    expect(fetchMock.mock.calls.map(([u]) => new URL(u, "http://localhost").searchParams.get("q"))).toEqual(["ro", "roa", "roa"]);
    expect(seen.filter((d) => Array.isArray(d) && d.length === 0)).toEqual([]);
  });

  it("control: any other refusal still reads as no matches", async () => {
    answers = { ro: [json({ error: "forbidden" }, 403)] };
    const { result } = renderHook(() => useEntitySearch("org-1", "ro"), { wrapper });
    await waitFor(() => expect(result.current.data).toEqual([]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
