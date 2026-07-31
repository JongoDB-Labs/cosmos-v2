/**
 * Every cache entry that projects the `milestone` table.
 *
 * Milestones are served by TWO endpoints over the SAME rows:
 *
 *   /milestones  → the Milestones board and the Release Timeline
 *   /schedule    → the PM Dashboard's Schedule register (adds derived fields)
 *
 * They are cached separately — correctly, because the two projections have
 * different shapes and sharing one entry would make each overwrite the other's
 * fields. What was missing is that a WRITE through either endpoint changes rows
 * the other is showing, and neither invalidated the other. So a milestone
 * created, retitled, re-dated or deleted on the Milestones board left the
 * Schedule register showing the old row until a reload, and vice versa — one
 * record, two screens, two answers.
 *
 * Both keys live here, in one list, so a write site cannot invalidate half of
 * them. `milestone-sync.arch.test.ts` fails any component that names one key
 * without the other.
 */
export function milestoneInvalidations(projectId: string): unknown[][] {
  return [
    ["milestones", projectId],
    ["schedule", projectId],
  ];
}
