import { ProjectStatus } from "@prisma/client";

/**
 * Display vocabulary for a project's lifecycle state.
 *
 * The enum values are the storage form; these are what a person reads. Kept in
 * one place because the alternative — each dropdown lowercasing and
 * underscore-replacing for itself — is how "On_hold" reaches a screen.
 *
 * Typed as a total Record, so adding a member to the enum fails the build here
 * rather than rendering the raw value somewhere nobody is looking.
 */
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  DRAFT: "Draft",
  ACTIVE: "Active",
  ON_HOLD: "On hold",
  COMPLETE: "Complete",
};

/**
 * Lifecycle order, for dropdowns and grouping — NOT alphabetical, and not the
 * enum's declaration order by accident. A project moves down this list.
 */
export const PROJECT_STATUS_ORDER: ProjectStatus[] = [
  ProjectStatus.DRAFT,
  ProjectStatus.ACTIVE,
  ProjectStatus.ON_HOLD,
  ProjectStatus.COMPLETE,
];

/** Label for a status, falling back to the raw value rather than blank. */
export function projectStatusLabel(status: string): string {
  return PROJECT_STATUS_LABELS[status as ProjectStatus] ?? status;
}

/**
 * Whether a status means the project is still being worked.
 *
 * Used for "open work" counts and defaults. COMPLETE is done and DRAFT has not
 * started, so neither is live — but note this says nothing about `archived`,
 * which is a separate axis: an archived project can be ACTIVE.
 */
export function isLiveStatus(status: ProjectStatus): boolean {
  return status === ProjectStatus.ACTIVE || status === ProjectStatus.ON_HOLD;
}
