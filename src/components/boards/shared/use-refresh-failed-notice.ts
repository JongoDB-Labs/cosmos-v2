"use client";

import { useEffect } from "react";
import { toast } from "sonner";

export const REFRESH_FAILED_TOAST_ID = "board-refresh-failed";
export const REFRESH_FAILED_MESSAGE = "Couldn't refresh. Showing the last loaded data.";

/**
 * One toast while a background refresh has failed and the view is showing the
 * data it loaded before. Same id every time, so it never stacks; no timeout,
 * so it stays up for as long as the refresh keeps failing. It goes away when
 * the next fetch succeeds, when the view unmounts, and when `noticeKey` (the
 * board or the queries it reads) changes.
 */
export function useRefreshFailedNotice(refreshFailed: boolean, noticeKey: string): void {
  useEffect(() => {
    if (!refreshFailed) return;
    toast.warning(REFRESH_FAILED_MESSAGE, { id: REFRESH_FAILED_TOAST_ID, duration: Infinity });
    return () => {
      toast.dismiss(REFRESH_FAILED_TOAST_ID);
    };
  }, [refreshFailed, noticeKey]);
}
