"use client";

import { useSyncExternalStore } from "react";
import { formatDateTimeStable, formatTimeStable } from "@/lib/format/stable-date";

/** Never fires: the value is constant per environment, so there is nothing to
 *  subscribe to. Module-level so the reference is stable across renders. */
const NO_SUBSCRIBE = () => () => {};

/**
 * True only once the component has hydrated in the browser.
 *
 * `useSyncExternalStore` is React's purpose-built answer here: its
 * `getServerSnapshot` (false) is what the server render and the client's FIRST
 * render both see, so the two agree, and the client then re-renders with the
 * client snapshot (true). Written this way rather than `useState` +
 * `useEffect(() => setMounted(true))` because that pattern schedules a cascading
 * render and the `react-hooks/set-state-in-effect` rule rejects it.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(
    NO_SUBSCRIBE,
    () => true,  // client
    () => false, // server + first client render
  );
}

/**
 * A timestamp shown in the READER's time zone, without a hydration mismatch.
 *
 * The rest of the date migration pins everything to UTC (see `stable-date.ts`),
 * which is right for coarse calendar dates — a "due" or "updated on" day should
 * not shift with the reader. It is wrong for an instant: pinning "last used" to
 * UTC tells a New York reader 10 PM for a 6 PM event. That is why those sites
 * could not simply be converted like the rest, and why this exists.
 *
 * How it avoids the mismatch: the server and the client's first render both emit
 * the UTC-pinned string, so the HTML matches. After mount the component re-renders
 * with the viewer's own zone. Both halves are the same shape, so the swap does
 * not reflow the row.
 *
 * The trade-off is honest and deliberate: for one paint the reader may see a
 * time in UTC. The alternative — rendering nothing until mount — leaves a hole in
 * the layout and, in this codebase specifically, a client component that returns
 * null on its first render has bitten us before.
 */
export function LocalTimestamp({
  value,
  fallback = "—",
}: {
  value: string | Date | null | undefined;
  /** Rendered when there is no timestamp at all. */
  fallback?: string;
}) {
  const mounted = useMounted();

  if (!value) return <>{fallback}</>;

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return <>{fallback}</>;

  // Pre-mount: the pinned string, identical on both sides of hydration.
  if (!mounted) return <>{formatDateTimeStable(date)}</>;

  // Post-mount: the reader's own zone and locale conventions.
  return (
    <>
      {date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })}
    </>
  );
}

/**
 * The time-of-day half of `<LocalTimestamp>`, for rows that already carry their
 * date in a group heading.
 *
 * Same contract: the pinned string pre-mount so hydration matches, the reader's
 * own zone after. Worth using even where the surrounding list is client-fetched
 * today — that only holds until someone prefetches the query, and the failure is
 * silent.
 */
export function LocalTime({
  value,
  fallback = "",
}: {
  value: string | Date | null | undefined;
  fallback?: string;
}) {
  const mounted = useMounted();

  if (!value) return <>{fallback}</>;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return <>{fallback}</>;

  if (!mounted) return <>{formatTimeStable(date)}</>;
  return <>{date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</>;
}
