"use client";

/**
 * Lazy-loaded recharts barrel.
 *
 * recharts (~110KB gzipped) is heavy enough to dominate the initial client
 * bundle when imported eagerly from chart-heavy dashboards. By re-exporting
 * each named export through `next/dynamic`, the entire recharts module is
 * split into its own async chunk that only loads when a chart actually
 * mounts on the client.
 *
 * Consumer files swap the import path (`recharts` -> this barrel) and keep
 * the same named-export ergonomics.
 *
 * `ssr: false` is appropriate because these are interactive client charts —
 * SSR'ing them produces a sized SVG that immediately gets replaced once the
 * client recharts module hydrates, so we save the server work too.
 */

import dynamic from "next/dynamic";

// Re-export recharts types directly. Type-only imports are erased at compile
// time, so they do not pull recharts into the runtime bundle.
export type { PieLabelRenderProps } from "recharts";

const ChartFallback = () => (
  <div className="flex h-full min-h-[200px] items-center justify-center text-xs text-muted-foreground">
    Loading chart…
  </div>
);

// Containers / charts
export const ResponsiveContainer = dynamic(
  () => import("recharts").then((m) => m.ResponsiveContainer),
  { ssr: false, loading: ChartFallback },
);
export const BarChart = dynamic(
  () => import("recharts").then((m) => m.BarChart),
  { ssr: false },
);
export const LineChart = dynamic(
  () => import("recharts").then((m) => m.LineChart),
  { ssr: false },
);
export const AreaChart = dynamic(
  () => import("recharts").then((m) => m.AreaChart),
  { ssr: false },
);
export const PieChart = dynamic(
  () => import("recharts").then((m) => m.PieChart),
  { ssr: false },
);

// Series primitives
export const Bar = dynamic(() => import("recharts").then((m) => m.Bar), {
  ssr: false,
});
export const Line = dynamic(() => import("recharts").then((m) => m.Line), {
  ssr: false,
});
export const Area = dynamic(() => import("recharts").then((m) => m.Area), {
  ssr: false,
});
export const Pie = dynamic(() => import("recharts").then((m) => m.Pie), {
  ssr: false,
});
export const Cell = dynamic(() => import("recharts").then((m) => m.Cell), {
  ssr: false,
});

// Axes / grid / decoration
export const XAxis = dynamic(() => import("recharts").then((m) => m.XAxis), {
  ssr: false,
});
export const YAxis = dynamic(() => import("recharts").then((m) => m.YAxis), {
  ssr: false,
});
export const CartesianGrid = dynamic(
  () => import("recharts").then((m) => m.CartesianGrid),
  { ssr: false },
);
export const Tooltip = dynamic(
  () => import("recharts").then((m) => m.Tooltip),
  { ssr: false },
);
export const Legend = dynamic(() => import("recharts").then((m) => m.Legend), {
  ssr: false,
});
export const ReferenceLine = dynamic(
  () => import("recharts").then((m) => m.ReferenceLine),
  { ssr: false },
);
