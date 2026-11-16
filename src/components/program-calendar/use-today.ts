"use client";

import { useSyncExternalStore } from "react";
import { localToday } from "@/lib/program-calendar/time";

/** Nothing to subscribe to; module-level so the reference is stable. */
const NO_SUBSCRIBE = () => () => {};

/**
 * Today's date on the READER's calendar, as that date's UTC midnight in ms
 * (`localToday`). Null on the server and on the client's first (hydrating)
 * render.
 *
 * It is the reader's date and not UTC's, because events are drawn on the date
 * they are held (`drawnRange`): at 20:00 in Los Angeles the UTC date is already
 * tomorrow, and the tint sat on tomorrow's column.
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
 * reader's day does.
 */
export function useToday(): number | null {
  return useSyncExternalStore(
    NO_SUBSCRIBE,
    () => localToday().getTime(),
    () => null,
  );
}
