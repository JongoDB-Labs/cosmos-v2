"use client";

import { type ReactNode } from "react";

/**
 * Page-level content wrapper for route navigations.
 *
 * This used to reach for `React.unstable_ViewTransition` through a typed
 * indirection, falling back to a passthrough when the runtime export was
 * missing. The export is missing in every React build in this tree (React
 * 19.2.8 exposes no `ViewTransition` at all), so the fallback was the only
 * branch that ever ran and the indirection bought nothing but the appearance
 * of a feature. It renders its children, and that is all it has ever done.
 *
 * The `::view-transition-*(page)` keyframes in globals.css are likewise inert
 * today; they are left in place so re-enabling this is a one-component change
 * once React ships a stable `<ViewTransition>`. `name` is still accepted for
 * the same reason — call sites don't have to change either way.
 */
export function PageTransition({
  children,
}: {
  children: ReactNode;
  name?: string;
}) {
  return <>{children}</>;
}
