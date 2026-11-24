// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

const toastMock = vi.hoisted(() => ({ warning: vi.fn(), dismiss: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

import {
  REFRESH_FAILED_MESSAGE,
  REFRESH_FAILED_TOAST_ID,
  useRefreshFailedNotice,
} from "./use-refresh-failed-notice";

beforeEach(() => {
  toastMock.warning.mockClear();
  toastMock.dismiss.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("useRefreshFailedNotice", () => {
  it("shows one persistent toast while failing and dismisses it on recovery", () => {
    vi.useFakeTimers();
    const { rerender } = renderHook(({ failed }) => useRefreshFailedNotice(failed, "k1"), {
      initialProps: { failed: false },
    });
    expect(toastMock.warning).not.toHaveBeenCalled();

    rerender({ failed: true });
    rerender({ failed: true });
    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    expect(toastMock.warning).toHaveBeenCalledWith(REFRESH_FAILED_MESSAGE, {
      id: REFRESH_FAILED_TOAST_ID,
      duration: Infinity,
    });

    // Still failing 10s later: nothing has dismissed it.
    vi.advanceTimersByTime(10_000);
    expect(toastMock.dismiss).not.toHaveBeenCalled();

    rerender({ failed: false });
    expect(toastMock.dismiss).toHaveBeenCalledWith(REFRESH_FAILED_TOAST_ID);
  });

  it("dismisses on unmount", () => {
    const { unmount } = renderHook(() => useRefreshFailedNotice(true, "k1"));
    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    unmount();
    expect(toastMock.dismiss).toHaveBeenCalledWith(REFRESH_FAILED_TOAST_ID);
  });

  it("dismisses when the board or its query keys change", () => {
    const { rerender } = renderHook(({ k, failed }) => useRefreshFailedNotice(failed, k), {
      initialProps: { k: "board-a", failed: true },
    });
    rerender({ k: "board-b", failed: false });
    expect(toastMock.dismiss).toHaveBeenCalledWith(REFRESH_FAILED_TOAST_ID);
    expect(toastMock.warning).toHaveBeenCalledTimes(1);
  });
});
