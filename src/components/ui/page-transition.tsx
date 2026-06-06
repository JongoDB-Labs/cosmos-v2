"use client";

import { type ReactNode } from "react";
// React 19.2 exposes the View Transitions API as `unstable_ViewTransition`,
// but the official `@types/react` may not declare it yet — pull via a typed
// indirection so we don't fight the type system. Falls back to a passthrough
// if the runtime export is missing.
import * as React from "react";

type ViewTransitionLike = React.ComponentType<{
  children: ReactNode;
  name?: string;
}>;

const ViewTransition: ViewTransitionLike =
  (
    React as unknown as {
      unstable_ViewTransition?: ViewTransitionLike;
    }
  ).unstable_ViewTransition ??
  ((props: { children: ReactNode }) => <>{props.children}</>);

/**
 * Page-level View Transition wrapper. In browsers + React runtimes that
 * support it, this tags a content region with a transition name so route
 * navigations produce a smooth cross-fade. Browsers without support
 * degrade to a normal swap.
 *
 * Enabled globally by `experimental.viewTransition: true` in next.config.ts;
 * the CSS keyframes in globals.css drive the fade itself.
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
