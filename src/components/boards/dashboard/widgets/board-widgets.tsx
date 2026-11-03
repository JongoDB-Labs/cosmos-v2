"use client";

/**
 * The widget components a DASHBOARD-family board can actually draw, and their
 * entries in `WidgetRegistry`.
 *
 * SEVEN of the catalogue's thirty-one types are implemented — the ones that can
 * be answered from data `dashboard-view.tsx` already loads. Everything else
 * renders a tile naming the type (see `widget-grid.tsx`), which is a deliberate
 * choice over two worse ones: a blank tile reads as a broken board, and a
 * generic breakdown under a borrowed title ("Team Velocity" over a status
 * split) renders happily and LIES. The same reasoning already guards the
 * increment scope on this board: "the panels would render, and lie."
 *
 * Which is also why the sector skins are NOT quietly routed to their
 * `baseType`. `software.velocity`'s preset asks for completed-vs-committed
 * points per sprint and `aec.rfi-tracker`'s for a ball-in-court column; this
 * product's work items hold neither. A skin whose preset we cannot honour gets
 * the unavailable tile.
 */
import { MetricCard } from "./metric-card";
import { PriorityChart } from "./priority-chart";
import { BurndownChart } from "./burndown-chart";
import { cn } from "@/lib/utils";
import { WIDGET_DEFINITIONS } from "@/lib/boards/widget-definitions";
import {
  WidgetRegistry,
  type WidgetProps,
  type WidgetRegistration,
} from "@/lib/boards/widget-registry";
import {
  widgetConfigNumber,
  widgetConfigText,
  widgetGroupKey,
  widgetGroupLabel,
  widgetMaxItems,
  widgetMetricKey,
  widgetMetricLabel,
} from "@/lib/boards/widget-data";

/** The seven generic types this module draws. Exported for the arch test. */
export const IMPLEMENTED_WIDGET_TYPES = [
  "counter",
  "kpi-card",
  "bar-chart",
  "line-chart",
  "table",
  "list",
  "text-block",
] as const;

/**
 * A widget mounted without board data (the builder's preview) says so rather
 * than drawing a zero. A zero is a claim about the project.
 */
function NoData({ children = "No data yet" }: { children?: string }) {
  return (
    <div className="flex h-full items-center justify-center text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * `widget-value-<id>`, so a test can assert THIS tile's number rather than
 * matching a bare digit that also appears in three other tiles — the same
 * reason `MetricCard` carries its own `metric-<label>` id. (A KPI card renders
 * through `MetricCard` and inherits that one, so only the counter needs this.)
 */
function valueTestId(props: WidgetProps): string | undefined {
  const id = props.config.__widgetId;
  return typeof id === "string" ? `widget-value-${id}` : undefined;
}

// ── counter ──────────────────────────────────────────────────────────────────

function CounterWidget(props: WidgetProps) {
  const metric = widgetMetricKey(props.config);
  const label = widgetConfigText(
    props.config,
    "label",
    widgetMetricLabel(metric),
  );
  if (!props.data) return <NoData />;
  return (
    <div className="flex h-full flex-col justify-center">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        data-testid={valueTestId(props)}
        className="text-3xl font-bold tabular-nums"
      >
        {props.data.metrics[metric]}
      </span>
    </div>
  );
}

// ── kpi-card ─────────────────────────────────────────────────────────────────

function KpiCardWidget(props: WidgetProps) {
  const metric = widgetMetricKey(props.config);
  const label = widgetConfigText(
    props.config,
    "label",
    widgetMetricLabel(metric),
  );
  const target = widgetConfigNumber(props.config, "target");
  if (!props.data) return <NoData />;

  const value = props.data.metrics[metric];
  // Deliberately NOT coloured good/bad. Whether being above target is good
  // depends on the metric — "Completed" and "Overdue" want opposite signs — and
  // nothing in the config says which, so the delta is reported, not judged.
  const delta = target === null ? null : value - target;
  return (
    <div className="flex h-full flex-col justify-center">
      <MetricCard
        label={label}
        value={value}
        trend={
          delta === null ? undefined : delta === 0 ? "flat" : delta > 0 ? "up" : "down"
        }
        trendValue={
          delta === null
            ? undefined
            : `${delta > 0 ? "+" : ""}${delta} vs target ${target}`
        }
      />
      {target === null && (
        <span className="mt-1 text-[11px] text-muted-foreground">
          No target set
        </span>
      )}
    </div>
  );
}

// ── bar-chart ────────────────────────────────────────────────────────────────

/**
 * The fallback bar colour, matching the stock panels' own `?? "#6b7280"`.
 *
 * Needed because only some groupings carry a colour: status and priority have
 * one per bucket, an assignee does not, and a work type's is nullable. The
 * chart takes a required `color`, so an uncoloured bucket must be given this
 * rather than `undefined` — which recharts draws as no fill at all, i.e. an
 * invisible bar in a chart that still reserves its space.
 */
const DEFAULT_BAR_COLOR = "#6b7280";

function BarChartWidget(props: WidgetProps) {
  const group = widgetGroupKey(props.config);
  if (!props.data) return <NoData />;
  const series = props.data.series[group].map((p) => ({
    name: p.name,
    value: p.value,
    color: p.color ?? DEFAULT_BAR_COLOR,
  }));
  return (
    <div className="flex h-full flex-col">
      <span className="mb-1 shrink-0 text-[11px] text-muted-foreground">
        By {widgetGroupLabel(group).toLowerCase()}
      </span>
      <div className="min-h-0 flex-1">
        {/* `PriorityChart` is a plain `{name, value, color}[]` bar chart — its
            name records the first caller, not a restriction. Reused rather than
            re-implemented so the axis styling, the empty state and the tooltip
            tokens stay identical to the stock Priority panel beside it. */}
        <PriorityChart data={series} />
      </div>
    </div>
  );
}

// ── line-chart ───────────────────────────────────────────────────────────────

function LineChartWidget(props: WidgetProps) {
  if (!props.data) return <NoData />;
  return (
    <div className="flex h-full flex-col">
      {/* The board computes exactly one time series — the active interval's
          burndown — so the caption names it. An unlabelled line on a tile
          titled "Line Chart" tells a reader nothing about what they are
          looking at. */}
      <span className="mb-1 shrink-0 text-[11px] text-muted-foreground">
        Interval burndown
      </span>
      <div className="min-h-0 flex-1">
        <BurndownChart data={props.data.burndown} />
      </div>
    </div>
  );
}

// ── table ────────────────────────────────────────────────────────────────────

const TABLE_COLUMNS = [
  { key: "key", label: "Key" },
  { key: "title", label: "Title" },
  { key: "status", label: "Status" },
  { key: "priority", label: "Priority" },
  { key: "assignee", label: "Assignee" },
  { key: "dueDate", label: "Due" },
] as const;

type TableColumnKey = (typeof TABLE_COLUMNS)[number]["key"];

/**
 * Which columns to show. A config may name a subset; names this product has no
 * field for (an AEC skin's `ballInCourt`, a gradebook's `midterm`) are dropped,
 * and a config that leaves NOTHING recognised falls back to the full set rather
 * than rendering a table with no columns.
 */
function tableColumns(config: Record<string, unknown>) {
  const raw = config.columns;
  if (!Array.isArray(raw)) return TABLE_COLUMNS;
  const wanted = new Set(raw.filter((c): c is string => typeof c === "string"));
  const picked = TABLE_COLUMNS.filter((c) => wanted.has(c.key));
  return picked.length > 0 ? picked : TABLE_COLUMNS;
}

function cellOf(row: Record<TableColumnKey, string | null>, key: TableColumnKey) {
  return row[key] ?? "—";
}

function TableWidget(props: WidgetProps) {
  const columns = tableColumns(props.config);
  const limit = widgetMaxItems(props.config, 25);
  if (!props.data) return <NoData />;
  const rows = props.data.rows.slice(0, limit);
  if (rows.length === 0) return <NoData>No matching items</NoData>;

  return (
    // Focusable: a table of plain text in an `overflow-auto` box has no
    // focusable descendant, which is `scrollable-region-focusable` (serious)
    // — and genuinely unreachable by keyboard, which is the real problem the
    // rule describes. `widget-grid.test.tsx` pins this as a property over the
    // whole rendered tree, because the e2e a11y gate never loads a board with
    // saved widgets.
    <div className="h-full overflow-auto" tabIndex={0}>
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-background">
          <tr className="border-b">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className="px-2 py-1 font-medium text-muted-foreground"
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b last:border-0">
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cn(
                    "px-2 py-1",
                    c.key === "title" && "max-w-[18rem] truncate",
                    c.key === "key" && "font-mono text-muted-foreground",
                  )}
                >
                  {cellOf(r, c.key)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {props.data.rows.length > rows.length && (
        <p className="px-2 py-1 text-[11px] text-muted-foreground">
          Showing {rows.length} of {props.data.rows.length}
        </p>
      )}
    </div>
  );
}

// ── list ─────────────────────────────────────────────────────────────────────

function ListWidget(props: WidgetProps) {
  const limit = widgetMaxItems(props.config, 10);
  if (!props.data) return <NoData />;
  const rows = props.data.rows.slice(0, limit);
  if (rows.length === 0) return <NoData>No matching items</NoData>;

  return (
    // Focusable for the same reason as the table above.
    <div className="h-full overflow-auto" tabIndex={0}>
      {/* A real <ul>/<li>, so a test can assert on the LIST rather than on a
          substring of the tile — see memory: a-loose-assertion-is-a-false-green,
          case 5. */}
      <ul className="divide-y text-xs">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center gap-2 px-1 py-1.5">
            <span className="shrink-0 font-mono text-muted-foreground">
              {r.key}
            </span>
            <span className="flex-1 truncate">{r.title}</span>
            <span className="shrink-0 text-muted-foreground">{r.status}</span>
          </li>
        ))}
      </ul>
      {props.data.rows.length > rows.length && (
        <p className="px-1 py-1 text-[11px] text-muted-foreground">
          Showing {rows.length} of {props.data.rows.length}
        </p>
      )}
    </div>
  );
}

// ── text-block ───────────────────────────────────────────────────────────────

function TextBlockWidget(props: WidgetProps) {
  const content = widgetConfigText(props.config, "content");
  if (content.length === 0) {
    return <NoData>Nothing written here yet</NoData>;
  }
  // Rendered as TEXT, never as markup. The palette calls this a "rich text
  // block", but the builder's control is a bare <textarea> and the value is
  // author-supplied free text stored on a shared board row — injecting it as
  // HTML would be stored XSS for every viewer of the board.
  return (
    // Focusable for the same reason as the table and list above: long text in a
    // scroll box with nothing tabbable inside it.
    <div
      className="h-full overflow-auto whitespace-pre-wrap text-sm"
      tabIndex={0}
    >
      {content}
    </div>
  );
}

// ── registrations ────────────────────────────────────────────────────────────

const COMPONENTS: Record<
  (typeof IMPLEMENTED_WIDGET_TYPES)[number],
  (props: WidgetProps) => React.ReactNode
> = {
  counter: CounterWidget,
  "kpi-card": KpiCardWidget,
  "bar-chart": BarChartWidget,
  "line-chart": LineChartWidget,
  table: TableWidget,
  list: ListWidget,
  "text-block": TextBlockWidget,
};

/**
 * Built from `WIDGET_DEFINITIONS` so a widget's name, icon and description have
 * ONE spelling — the definitions file is what the palette reads, so a
 * registration that invented its own label would mean the thing you add and the
 * thing you see are differently named.
 *
 * A type listed here but absent from the catalogue throws at module load rather
 * than registering a widget the palette cannot offer. That reads harsh for
 * browser code, but it is really a build-time guard: the production build
 * prerenders the routes that import this, so the throw cannot reach a user — it
 * fails the build first.
 */
export const BOARD_WIDGET_REGISTRATIONS: WidgetRegistration[] =
  IMPLEMENTED_WIDGET_TYPES.map((type) => {
    const def = WIDGET_DEFINITIONS.find((d) => d.type === type);
    if (!def) {
      throw new Error(
        `widget "${type}" is implemented but absent from WIDGET_DEFINITIONS`,
      );
    }
    return {
      slug: def.type,
      name: def.name,
      category: def.category,
      icon: def.icon,
      description: def.description,
      minWidth: 2,
      minHeight: 1,
      defaultConfig: def.presetConfig ?? {},
      Component: COMPONENTS[type],
    };
  });

/**
 * Put every implemented widget in the registry.
 *
 * A FUNCTION, not a module side effect. An import whose only purpose is a
 * side effect is the thing bundlers, HMR and `verbatimModuleSyntax` all like
 * to drop, and the symptom would be a board of "not available yet" tiles with
 * nothing in the diff to explain it. `widget-grid.tsx` calls this before it
 * reads; `register` is a Map `set`, so calling it twice is a no-op.
 */
export function registerBoardWidgets(): void {
  for (const registration of BOARD_WIDGET_REGISTRATIONS) {
    WidgetRegistry.register(registration);
  }
}
