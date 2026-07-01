/**
 * Deep-link builders for entity references. PURE (no server/client deps) so the
 * search + resolve endpoints (server) and chips (client) build identical URLs.
 *
 * Project-scoped types need the owning project's `key`; when it's missing
 * (entity not found / not readable) we return null and the chip renders as a
 * non-linking label. `user` has no profile page → always null.
 *
 * Item-level routes that exist today: meetings, documents (files), boards,
 * projects. Work items + notes use a `?item=` / `?note=` focus param that the
 * org issues view + notes view honor (wired in Phase 2/4). The remaining
 * list-based types (PM registers, milestones, OKRs, goals, KPIs) link to their
 * page.
 */
import type { EntityType } from "./refs";

export type UrlParts = {
  orgSlug: string;
  /** Required for project-scoped types; omit for org-level types. */
  projectKey?: string | null;
  id: string;
};

export function entityUrl(type: EntityType, parts: UrlParts): string | null {
  const { orgSlug: o, projectKey: k, id } = parts;
  const proj = (suffix: string) => (k ? `/${o}/projects/${k}${suffix}` : null);
  switch (type) {
    case "user":
      return null; // no profile page
    case "project":
      return k ? `/${o}/projects/${k}` : null;
    case "workItem":
      return `/${o}/issues?item=${id}`;
    case "note":
      return `/${o}/notes?note=${id}`;
    case "meeting":
      return `/${o}/meetings/${id}`;
    case "crmContact":
      return `/${o}/crm`;
    case "partner":
      return `/${o}/partners`;
    case "product":
      return `/${o}/products`;
    case "board":
      return proj(`/boards/${id}`);
    case "document":
      return proj(`/files/${id}`);
    case "milestone":
      return proj(`/milestones`);
    case "objective":
      return proj(`/okrs`);
    case "goal":
      return proj(`/goals`);
    case "kpi":
      return proj(`/kpis`);
    case "risk":
      return proj(`/pm-dashboard/risks`);
    case "deliverable":
      return proj(`/pm-dashboard/deliverables`);
    case "blocker":
      return proj(`/pm-dashboard/blockers`);
    case "changeRequest":
      return proj(`/pm-dashboard/changes`);
    case "clin":
      return proj(`/pm-dashboard/clins`);
    default:
      return null;
  }
}
