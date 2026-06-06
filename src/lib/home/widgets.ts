/**
 * Catalog of personal Home-dashboard widget types. Shared by the home-widgets
 * route (POST validation) and the Home dashboard UI (palette + rendering).
 *
 * v1 widgets are org-wide metric cards sourced from existing ORG_READ routes
 * (/analytics/portfolio, /members) — no new data layer, no finance gating.
 */
// `source` is the data route a widget reads from, which determines the
// permission it needs: "portfolio" → /analytics/portfolio (ANALYTICS_READ),
// "members" → /members (ORG_READ). The UI uses this to hide widgets a user
// can't populate. (active_projects/team-count were dropped from the catalog to
// avoid duplicating the static KPI cards directly above the dashboard.)
export const HOME_WIDGET_TYPES = [
  { type: "open_items", label: "Open work items", source: "portfolio" },
  { type: "in_progress_items", label: "In progress", source: "portfolio" },
  { type: "completed_items", label: "Completed items", source: "portfolio" },
  { type: "overdue_items", label: "Overdue items", source: "portfolio" },
  { type: "team_members", label: "Team members", source: "members" },
] as const;

export type HomeWidgetType = (typeof HOME_WIDGET_TYPES)[number]["type"];

export const HOME_WIDGET_TYPE_KEYS = HOME_WIDGET_TYPES.map(
  (w) => w.type,
) as HomeWidgetType[];

export const HOME_WIDGET_LABELS: Record<string, string> = Object.fromEntries(
  HOME_WIDGET_TYPES.map((w) => [w.type, w.label]),
);

export const HOME_WIDGET_SOURCE: Record<string, "portfolio" | "members"> =
  Object.fromEntries(HOME_WIDGET_TYPES.map((w) => [w.type, w.source]));

export function isHomeWidgetType(v: string): v is HomeWidgetType {
  return (HOME_WIDGET_TYPE_KEYS as string[]).includes(v);
}
