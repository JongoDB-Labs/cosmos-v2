"use client";

/**
 * The width a react-grid-layout grid draws at, measured from the space it sits
 * in.
 *
 * Every dashboard grid used to pass a fixed `width={1200}`. The library does
 * not measure anything itself, so it drew 1200px whatever the room: on a
 * 1440px screen with the sidebar open the board area is about 1150px wide, and
 * the right-hand column of every dashboard ran past the edge — half a chart and
 * a clipped axis, on the screen someone is presenting at standup.
 *
 * Why a hook of our own and not the library's `useContainerWidth`: half the
 * dashboard tests stub `react-grid-layout` with only `GridLayout` in it, and a
 * new import from that module would be `undefined` in every one of them.
 */
import { useEffect, useState } from "react";

/** What every grid drew at before this, and still draws at until measured. */
export const FALLBACK_GRID_WIDTH = 1200;

/**
 * `ref` goes on an element with NO padding of its own (the grid's direct
 * wrapper): its content width is the room the grid has.
 *
 * Starts at the fallback, so the server render and the first client render
 * agree, and keeps it wherever nothing can be measured — a `display:none`
 * wrapper (the desktop grid below `md`) and jsdom both report a width of 0,
 * and a 0-wide grid draws every tile as a sliver.
 *
 * A callback ref (state), not `useRef`: a component that calls this hook may
 * render its wrapper only on a later render (a loading skeleton first). An
 * effect keyed on a ref object would run once against `null` and never
 * observe anything; keyed on the node, it starts observing when it appears.
 * `FitWidth` below always renders its wrapper, but the hook is exported.
 */
export function useFitWidth(): {
  ref: (node: HTMLDivElement | null) => void;
  width: number;
} {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(FALLBACK_GRID_WIDTH);
  useEffect(() => {
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const measured = Math.round(entries[0]?.contentRect.width ?? 0);
      if (measured > 0) setWidth(measured);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return { ref: setNode, width };
}

/** A wrapper that hands its children the width it measured. */
export function FitWidth({
  children,
}: {
  children: (width: number) => React.ReactNode;
}) {
  const { ref, width } = useFitWidth();
  return <div ref={ref}>{children(width)}</div>;
}
