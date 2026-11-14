// @vitest-environment jsdom
//
// The query bar's URL state: two setters in one handler keep both changes.
//
// "Run as a query" sets the query and then the mode, in one click. Each setter
// rewrote the URL from the `searchParams` of the render it came from, so the
// second one started from the URL before the first and undid it: the bar
// switched to CQL with the query gone (seen on a board, where the CQL editor
// opened empty). `useSearchParams` here is a snapshot per render, as in Next,
// which only syncs a History API change into it on a later render.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

import { useCqlUrlState } from "./use-cql";

beforeEach(() => {
  window.history.replaceState(null, "", "/test-org/projects/P/boards/b1?interval=i1&mode=basic");
});

describe("useCqlUrlState", () => {
  it("keeps the query when the mode is set straight after it, as Run as a query does", () => {
    const { result } = renderHook(() => useCqlUrlState());
    act(() => {
      result.current.setCql("priority = MEDIUM");
      result.current.setMode("advanced");
    });
    const params = new URLSearchParams(window.location.search);
    expect(params.get("cql")).toBe("priority = MEDIUM");
    expect(params.get("mode")).toBe("advanced");
    // Whatever else the page had in the URL stays.
    expect(params.get("interval")).toBe("i1");
  });

  it("still clears a param set to null or empty", () => {
    window.history.replaceState(null, "", "/w?cql=a%20%3D%201&mode=advanced");
    const { result } = renderHook(() => useCqlUrlState());
    act(() => result.current.setCql(""));
    expect(window.location.search).toBe("?mode=advanced");
  });
});
