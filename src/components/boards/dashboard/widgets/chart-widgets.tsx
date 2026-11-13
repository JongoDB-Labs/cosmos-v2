"use client";

/**
 * The chart widgets beyond the original bar and line: an area chart of work
 * created against work completed, a donut, a gauge, and sprint velocity.
 *
 * Each one reads only the board's widget bag (`BoardWidgetData`), which the
 * board builds from the routes it already loaded under the viewer's own access
 * — so none of them can show an item the board itself would not.
 */
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "@/components/charts/lazy-recharts";
import { StatusChart } from "./status-chart";
import type { WidgetProps } from "@/lib/boards/widget-registry";
import {
  widgetDays,
  widgetGroupKey,
  widgetGroupLabel,
  widgetRatioKey,
  WIDGET_RATIOS,
  type WidgetItemRow,
} from "@/lib/boards/widget-data";
import {
  addDays,
  CATEGORICAL,
  Caption,
  formatDay,
  localDayKey,
  NoData,
  valueTestId,
} from "./widget-parts";

const TOOLTIP = {
  backgroundColor: "var(--overlay)",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  fontSize: "12px",
};

const AXIS_TICK = { fontSize: 10, fill: "var(--text-muted)" };

// ── area-chart: created vs completed ─────────────────────────────────────────

export interface FlowPoint {
  day: string;
  label: string;
  created: number;
  completed: number;
}

/**
 * How much work existed and how much was finished, at the end of each of the
 * last `days` days. Both run cumulatively from the start of the board's
 * history, so the gap between the two areas on any day is the work still open
 * then. Exported for its test.
 *
 * Read off each item's own timestamps — `createdAt`, and `completedAt` for an
 * item still in a done status — because those are the only history the board
 * already holds; an item reopened after completion has no `completedAt` and is
 * counted as open, as it is.
 */
export function cumulativeFlow(
  rows: WidgetItemRow[],
  days: number,
  now: Date,
): FlowPoint[] {
  const today = localDayKey(now);
  const first = addDays(today, -(days - 1));
  const createdOn = rows.map((r) => localDayKey(new Date(r.createdAt))).sort();
  const completedOn = rows
    .filter((r) => r.statusCategory === "DONE" && r.completedAt)
    .map((r) => localDayKey(new Date(r.completedAt!)))
    .sort();

  const points: FlowPoint[] = [];
  let ci = 0;
  let di = 0;
  for (let i = 0; i < days; i++) {
    const day = addDays(first, i);
    while (ci < createdOn.length && createdOn[ci] <= day) ci++;
    while (di < completedOn.length && completedOn[di] <= day) di++;
    points.push({ day, label: formatDay(day), created: ci, completed: di });
  }
  return points;
}

export function AreaChartWidget(props: WidgetProps) {
  const days = widgetDays(props.config, 30);
  if (!props.data) return <NoData />;
  if (props.data.rows.length === 0) return <NoData>No matching items</NoData>;
  const points = cumulativeFlow(props.data.rows, days, new Date());
  return (
    <div className="flex h-full flex-col">
      <Caption>Created and completed, last {days} days</Caption>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
            <XAxis
              dataKey="label"
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              minTickGap={24}
            />
            <YAxis
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
            />
            <Tooltip contentStyle={TOOLTIP} />
            <Legend
              verticalAlign="bottom"
              height={20}
              iconType="circle"
              iconSize={8}
              formatter={(value: string) => (
                <span style={{ color: "var(--text)", fontSize: "11px" }}>{value}</span>
              )}
            />
            {/* Created FIRST so completed paints on top of it: SVG has no
                z-index, and the completed area always sits inside the created
                one, so drawn the other way round it would be hidden. */}
            <Area
              type="monotone"
              dataKey="created"
              name="Created"
              stroke="var(--status-progress)"
              fill="var(--status-progress)"
              fillOpacity={0.18}
              strokeWidth={2}
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="completed"
              name="Completed"
              stroke="var(--status-done)"
              fill="var(--status-done)"
              fillOpacity={0.35}
              strokeWidth={2}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ── pie-chart ────────────────────────────────────────────────────────────────

export function PieChartWidget(props: WidgetProps) {
  const group = widgetGroupKey(props.config);
  if (!props.data) return <NoData />;
  const series = props.data.series[group].map((p, i) => ({
    name: p.name,
    value: p.value,
    // Status and priority bring their own colours; an assignee brings none.
    color: p.color ?? CATEGORICAL[i % CATEGORICAL.length],
  }));
  return (
    <div className="flex h-full flex-col">
      <Caption>By {widgetGroupLabel(group).toLowerCase()}</Caption>
      <div className="min-h-0 flex-1">
        {/* The stock Status Distribution donut, reused so a pie on a custom
            layout and the stock panel look and behave the same. */}
        <StatusChart data={series} />
      </div>
    </div>
  );
}

// ── gauge ────────────────────────────────────────────────────────────────────

/** A point on the gauge's semicircle, `t` from 0 (left) to 1 (right). */
function arcPoint(t: number, r: number): [number, number] {
  const angle = Math.PI * (1 - t);
  return [60 + r * Math.cos(angle), 60 - r * Math.sin(angle)];
}

function arcPath(from: number, to: number, r: number): string {
  const [x0, y0] = arcPoint(from, r);
  const [x1, y1] = arcPoint(to, r);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export function GaugeWidget(props: WidgetProps) {
  const ratio = widgetRatioKey(props.config);
  const label = WIDGET_RATIOS.find((r) => r.key === ratio)!.label;
  if (!props.data) return <NoData />;
  const total = props.data.metrics.total;
  if (total === 0) return <NoData>No matching items</NoData>;
  const value = props.data.metrics[ratio];
  const share = Math.min(1, Math.max(0, value / total));
  const pct = Math.round(share * 100);
  // Overdue is the one share where more is worse; the others are neutral
  // progress, so they take the theme's own ink rather than a verdict colour.
  const ink = ratio === "overdue" ? "var(--status-critical)" : "var(--status-progress)";
  return (
    <div className="flex h-full flex-col items-center justify-center">
      <svg
        viewBox="0 0 120 70"
        className="h-full max-h-40 w-full"
        role="img"
        aria-label={`${label}: ${pct}% (${value} of ${total})`}
      >
        {/* Track first, value arc second: in SVG, document order IS paint
            order, so the arc must come after the track it sits on. */}
        <path
          d={arcPath(0, 1, 48)}
          fill="none"
          stroke="var(--border)"
          strokeWidth={10}
          strokeLinecap="round"
        />
        {share > 0 && (
          <path
            data-testid="gauge-value-arc"
            d={arcPath(0, share, 48)}
            fill="none"
            stroke={ink}
            strokeWidth={10}
            strokeLinecap="round"
          />
        )}
        <text
          x={60}
          y={58}
          textAnchor="middle"
          fontSize={18}
          fontWeight={700}
          fill="var(--text)"
          data-testid={valueTestId(props)}
        >
          {pct}%
        </text>
      </svg>
      <span className="text-[11px] text-muted-foreground">
        {value} of {total} {label.toLowerCase()}
      </span>
    </div>
  );
}

// ── software.velocity ────────────────────────────────────────────────────────

export function VelocityWidget(props: WidgetProps) {
  if (!props.data) return <NoData />;
  const points = props.data.velocity;
  if (points.length === 0) {
    return <NoData>No finished sprints with a recorded velocity yet</NoData>;
  }
  return (
    <div className="flex h-full flex-col">
      {/* Says it is not filtered: every other tile on the board answers to the
          filter bar, and this one deliberately does not. */}
      <Caption>Story points per finished sprint, as recorded at close</Caption>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
            <XAxis dataKey="name" tick={AXIS_TICK} axisLine={false} tickLine={false} />
            <YAxis
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
            />
            <Tooltip contentStyle={TOOLTIP} />
            <Legend
              verticalAlign="bottom"
              height={20}
              iconType="circle"
              iconSize={8}
              formatter={(value: string) => (
                <span style={{ color: "var(--text)", fontSize: "11px" }}>{value}</span>
              )}
            />
            <Bar
              dataKey="committed"
              name="Committed"
              fill="var(--status-neutral-text)"
              radius={[3, 3, 0, 0]}
              isAnimationActive={false}
            />
            <Bar
              dataKey="completed"
              name="Completed"
              fill="var(--status-done)"
              radius={[3, 3, 0, 0]}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
