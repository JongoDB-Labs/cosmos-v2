"use client";

import { useSyncExternalStore } from "react";
import { utcMidnight } from "@/lib/program-calendar/time";

/** Nothing to subscribe to; module-level so the reference is stable. */
const NO_SUBSCRIBE = () => () => {};

/**
 * Today's UTC midnight in ms, read from the READER's clock. Null on the server
 * and on the client's first (hydrating) render.
 *
 * The month and time grids used to read `new Date()` straight in render. The
 * server rendered the today tint on ITS day, and when the browser's day was
 * different, hydration left it there. React says so: "some attributes of the
 * server rendered HTML didn't match the client properties. This won't be
 * patched up." The tint then sat on the wrong column until a full client
 * render. That happens near UTC midnight, and on every load of a browser whose
 * clock is pinned, which made the a11y gate's pinned "today" a no-op. The gate
 * believed it was scanning chips on the tint while the tint stayed on the
 * server's real date.
 *
 * Returning null until hydration means the server and the first client render
 * agree (no column is today). The client then re-renders with its own day,
 * the same pattern `useMounted` in `ui/local-timestamp.tsx` uses. The value is
 * a number, so it compares equal between renders and only changes when the
 * UTC day does.
 */
export function useUtcToday(): number | null {
  return useSyncExternalStore(
    NO_SUBSCRIBE,
    () => utcMidnight(new Date()).getTime(),
    () => null,
  );
}
