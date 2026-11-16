import type { EventFilters } from "./service";

/** The filter query parameters as both calendar routes receive them. */
export interface EventFilterQuery {
  categoryIds?: string;
  ownerKeys?: string;
  projectId?: string;
  includeOrgEvents?: "true" | "false";
  showOnDashboardOnly?: "true" | "false";
  customerAttending?: "true" | "false";
  hasDeliverable?: "true" | "false";
}

const csv = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

/**
 * Query parameters to the service's filters. One reading for the events list
 * and the category counts: the counts were once read from the window alone,
 * and so stayed org-wide with a project picked.
 */
export function eventFiltersFromQuery(q: EventFilterQuery): EventFilters {
  return {
    categoryIds: csv(q.categoryIds),
    ownerKeys: csv(q.ownerKeys),
    projectId: q.projectId,
    includeOrgEvents: q.includeOrgEvents === "true",
    showOnDashboardOnly: q.showOnDashboardOnly === "true",
    customerAttending: q.customerAttending === "true",
    hasDeliverable: q.hasDeliverable === "true",
  };
}
