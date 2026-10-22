"use client";

import { ViewTransition, type ReactNode } from "react";

/**
 * Page-level View Transition wrapper. Tags a content region with a transition
 * name so route navigations produce a smooth cross-fade; browsers without the
 * View Transitions API degrade to a normal swap.
 *
 * React 19.3 exports the component as `ViewTransition`. It used to be looked
 * up as `unstable_ViewTransition` behind a passthrough fallback, and once that
 * name went away the fallback silently won and no page ever transitioned
 * (COSMOS-196). Importing it by name makes a future rename a type error.
 *
 * No Next config flag is needed (`experimental.viewTransition` was removed in
 * Next 16.3); the CSS keyframes in globals.css drive the fade itself.
 */
export function PageTransition({
  children,
  name = "page",
}: {
  children: ReactNode;
  name?: string;
}) {
  return <ViewTransition name={name}>{children}</ViewTransition>;
}
