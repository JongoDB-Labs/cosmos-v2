/**
 * Who to show as running a project, on the Projects page.
 *
 * Two things were wrong with the previous rule ("prefer LEAD, else MANAGER;
 * among equals the first row wins"):
 *
 *   1. It showed the wrong ROLE. A project's manager is who runs it; LEAD is a
 *      narrower role that happened to outrank MANAGER here, so a project with
 *      leads displayed one of them and hid its managers entirely.
 *   2. "The first row wins" had no ordering behind it. The query carried no
 *      `orderBy`, so with more than one candidate Postgres returned them in
 *      whatever order it liked — the displayed name could change after an
 *      unrelated row update, with nothing changing in the data. That is exactly
 *      what was reported: a project with two leads showed whichever came back
 *      first.
 *
 * So: managers, all of them, in a stable order. A project with no manager shows
 * nothing rather than falling back to a lead — the point is to name who manages
 * it, and inventing a stand-in is how the confusing display started.
 */

export interface ProjectManager {
  displayName: string;
  avatarUrl: string | null;
}

export interface ManagerRow {
  projectId: string;
  orgMember: { user: { displayName: string; avatarUrl: string | null } };
}

/**
 * Group manager rows by project, sorted by display name.
 *
 * Sorted, not "first row wins": the order decides both who appears first and who
 * is folded into the "+N", so leaving it to the database means the card can
 * change without the project changing. `localeCompare` so non-ASCII names sort
 * the way a reader expects rather than by code point.
 */
export function managersByProject(rows: ManagerRow[]): Map<string, ProjectManager[]> {
  const byProject = new Map<string, ProjectManager[]>();

  for (const row of rows) {
    const list = byProject.get(row.projectId) ?? [];
    list.push({
      displayName: row.orgMember.user.displayName,
      avatarUrl: row.orgMember.user.avatarUrl,
    });
    byProject.set(row.projectId, list);
  }

  for (const list of byProject.values()) {
    list.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  return byProject;
}
