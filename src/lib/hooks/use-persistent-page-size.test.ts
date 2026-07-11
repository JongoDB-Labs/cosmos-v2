// COSMOS-28 — a page-size choice for a view must persist across sessions. These
// lock the persistence contract: default when empty, rehydrate a stored choice
// after mount, write-through on change, and reject stale/invalid stored values.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePersistentPageSize } from "./use-persistent-page-size";

const KEY = "cosmos:test:page-size";
const OPTIONS = [25, 50, 100, 200] as const;

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("usePersistentPageSize", () => {
  it("starts at the default when nothing is stored", () => {
    const { result } = renderHook(() => usePersistentPageSize(KEY, 25, OPTIONS));
    expect(result.current[0]).toBe(25);
  });

  it("rehydrates a previously-stored size after mount", () => {
    window.localStorage.setItem(KEY, "100");
    const { result } = renderHook(() => usePersistentPageSize(KEY, 25, OPTIONS));
    // The rehydration effect runs after mount and picks up the stored value.
    expect(result.current[0]).toBe(100);
  });

  it("writes the chosen size through to storage and recovers it in a new session", () => {
    const { result } = renderHook(() => usePersistentPageSize(KEY, 25, OPTIONS));
    act(() => result.current[1](50));
    expect(result.current[0]).toBe(50);
    expect(window.localStorage.getItem(KEY)).toBe("50");

    // A fresh mount (a new session / reload) recovers the same choice.
    const second = renderHook(() => usePersistentPageSize(KEY, 25, OPTIONS));
    expect(second.result.current[0]).toBe(50);
  });

  it("ignores a stored value that isn't an allowed option", () => {
    window.localStorage.setItem(KEY, "999");
    const { result } = renderHook(() => usePersistentPageSize(KEY, 25, OPTIONS));
    expect(result.current[0]).toBe(25);
  });

  it("ignores a non-numeric stored value", () => {
    window.localStorage.setItem(KEY, "banana");
    const { result } = renderHook(() => usePersistentPageSize(KEY, 25, OPTIONS));
    expect(result.current[0]).toBe(25);
  });

  it("does not touch storage when no key is given (opt-in persistence)", () => {
    const setSpy = vi.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(() => usePersistentPageSize(null, 20, OPTIONS));
    act(() => result.current[1](50));
    expect(result.current[0]).toBe(50);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it("survives localStorage throwing (private mode) and still updates in-memory", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceeded");
    });
    const { result } = renderHook(() => usePersistentPageSize(KEY, 25, OPTIONS));
    expect(() => act(() => result.current[1](50))).not.toThrow();
    expect(result.current[0]).toBe(50);
  });
});
