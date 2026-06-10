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
// Charts / series / axes / decoration are RE-EXPORTED DIRECTLY (not via
// next/dynamic). recharts identifies these by component *type* when it walks
// the element tree (e.g. `<Cell>` per-element fills, `<XAxis dataKey>`), so a
// dynamic wrapper changes the type and recharts silently ignores them — which
// is why per-cell colors were dropped (black bars, single-color donuts) in both
// light and dark mode. Only `ResponsiveContainer` above stays `dynamic`/
// `ssr:false`; as the outermost wrapper it gates the whole chart to client
// render, so the direct children below never server-render (no hydration
// mismatch) — and recharts loads on chart pages (which import this barrel),
// while non-chart pages don't import it at all.
export {
  BarChart,
  LineChart,
  AreaChart,
  PieChart,
  Bar,
  Line,
  Area,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
} from "recharts";
