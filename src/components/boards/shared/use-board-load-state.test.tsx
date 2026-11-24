// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { renderHook, act, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { FetchError } from "@/lib/query/json-fetcher";
import { useBoardLoadState } from "./use-board-load-state";

afterEach(cleanup);

function setup(initial?: (qc: QueryClient) => void) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  initial?.(qc);
  const server = { fail: null as null | FetchError };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const hook = renderHook(
    ({ id }: { id: string }) => {
      const key = ["items", id];
      const q = useQuery({
        queryKey: key,
        queryFn: async () => {
          if (server.fail) throw server.fail;
          return [`item of ${id}`];
        },
      });
      return useBoardLoadState([{ queryKey: key, query: q, notFoundIsAccess: true }]);
    },
    { wrapper, initialProps: { id: "a" } },
  );
  return { qc, server, hook };
}

const http = (status: number) => new FetchError(status, null, `HTTP ${status}`);

describe("useBoardLoadState", () => {
  it("a failed fetch sets refreshFailed; setQueryData does not clear it; a successful fetch does", async () => {
    const { qc, server, hook } = setup();
    await waitFor(() => expect(hook.result.current.fatal).toBe(false));
    await waitFor(() => expect(qc.getQueryData(["items", "a"])).toBeTruthy());

    server.fail = http(500);
    await act(() => qc.refetchQueries({ queryKey: ["items", "a"] }));
    await waitFor(() => expect(hook.result.current.refreshFailed).toBe(true));
    expect(hook.result.current.fatal).toBe(false);

    // An optimistic write clears RQ's `error` without any fetch.
    act(() => qc.setQueryData(["items", "a"], ["optimistic"]));
    expect(qc.getQueryState(["items", "a"])?.error).toBeNull();
    expect(hook.result.current.refreshFailed).toBe(true);

    server.fail = null;
    await act(() => qc.refetchQueries({ queryKey: ["items", "a"] }));
    await waitFor(() => expect(hook.result.current.refreshFailed).toBe(false));
  });

  it("an access error latches fatal until a successful fetch", async () => {
    const { qc, server, hook } = setup();
    await waitFor(() => expect(qc.getQueryData(["items", "a"])).toBeTruthy());

    server.fail = http(403);
    await act(() => qc.refetchQueries({ queryKey: ["items", "a"] }));
    await waitFor(() => expect(hook.result.current.fatal).toBe(true));

    server.fail = http(500);
    await act(() => qc.refetchQueries({ queryKey: ["items", "a"] }));
    expect(hook.result.current.fatal).toBe(true);

    server.fail = null;
    await act(() => qc.refetchQueries({ queryKey: ["items", "a"] }));
    await waitFor(() => expect(hook.result.current.fatal).toBe(false));
    expect(hook.result.current.refreshFailed).toBe(false);
  });

  it("an access error stays latched after a remount when the next fetch fails differently", async () => {
    const first = setup();
    await waitFor(() => expect(first.qc.getQueryData(["items", "a"])).toBeTruthy());
    first.server.fail = http(403);
    await act(() => first.qc.refetchQueries({ queryKey: ["items", "a"] }));
    await waitFor(() => expect(first.hook.result.current.fatal).toBe(true));
    first.hook.unmount();

    // Remount on the same cache; the query still holds the 403 and its old data.
    const qc = first.qc;
    const server = { fail: http(500) as FetchError | null };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => {
        const key = ["items", "a"];
        const q = useQuery({
          queryKey: key,
          queryFn: async () => {
            if (server.fail) throw server.fail;
            return ["fresh"];
          },
        });
        return useBoardLoadState([{ queryKey: key, query: q, notFoundIsAccess: true }]);
      },
      { wrapper },
    );
    expect(result.current.fatal).toBe(true);
    await act(() => qc.refetchQueries({ queryKey: ["items", "a"] }));
    expect(result.current.fatal).toBe(true);
    expect(result.current.refreshFailed).toBe(false);
  });

  it("a key change resets the memory", async () => {
    const { qc, server, hook } = setup((qc) => qc.setQueryData(["items", "b"], ["cached b"]));
    await waitFor(() => expect(qc.getQueryData(["items", "a"])).toBeTruthy());
    server.fail = http(500);
    await act(() => qc.refetchQueries({ queryKey: ["items", "a"] }));
    await waitFor(() => expect(hook.result.current.refreshFailed).toBe(true));
    const before = hook.result.current.noticeKey;

    hook.rerender({ id: "b" });
    expect(hook.result.current.refreshFailed).toBe(false);
    expect(hook.result.current.noticeKey).not.toBe(before);
  });

  it("mounting onto a key already in error-with-data starts as refresh failed", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(["items", "a"], ["old"]);
    await qc
      .fetchQuery({ queryKey: ["items", "a"], queryFn: () => Promise.reject(http(500)), staleTime: 0 })
      .catch(() => {});
    expect(qc.getQueryState(["items", "a"])?.status).toBe("error");

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => {
        const key = ["items", "a"];
        const q = useQuery({ queryKey: key, queryFn: async () => ["fresh"], enabled: false });
        return useBoardLoadState([{ queryKey: key, query: q }]);
      },
      { wrapper },
    );
    expect(result.current).toMatchObject({ fatal: false, refreshFailed: true });
  });

  it("a cold-load failure is fatal; retry refetches and recovers", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let fail = true;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => {
        const key = ["items", "c"];
        const q = useQuery({
          queryKey: key,
          queryFn: async () => {
            if (fail) throw http(500);
            return ["ok"];
          },
        });
        return useBoardLoadState([{ queryKey: key, query: q }]);
      },
      { wrapper },
    );
    await waitFor(() => expect(result.current.fatal).toBe(true));
    fail = false;
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.fatal).toBe(false));
    expect(result.current.refreshFailed).toBe(false);
  });
});
