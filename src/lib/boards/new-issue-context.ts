/**
 * "New issue, here" — the create context published by whatever surface is on
 * screen, so the command palette (⌘K / Ctrl+K) can offer the SAME full create
 * dialog the surface's own "New issue" button opens (COSMOS-166).
 *
 * The palette is mounted once, in the dashboard layout, far above the board
 * views. It can already infer the PROJECT from the URL, but not the board, and
 * not which row you were looking at — and on the Timeline the toolbar (and with
 * it the "New issue" button) is hidden in fullscreen, which is exactly when the
 * keyboard is the only way in.
 *
 * So the surface pushes its context here and the palette reads it. A plain
 * module-level slot rather than React context on purpose: the publisher sits
 * BELOW the consumer in the tree, and the palette only needs the value at the
 * instant it opens — subscribing would re-render the whole palette every time
 * the pointer moved over another Gantt bar.
 */

export interface NewIssueContext {
  /** Where "here" is, for the palette row — e.g. `FSC timeline`. */
  scopeLabel: string;
  orgId: string;
  projectId: string;
  projectKey: string;
  projectName?: string;
  /** The project template's sector, which scopes the dialog's Type picker. */
  sector?: string | null;
  /** The board in scope, so the dialog's Status picker uses its workflow. */
  boardId?: string;
  /** `YYYY-MM-DD` seeds from the row in focus, when one is. */
  startDate?: string | null;
  dueDate?: string | null;
  /** Called after a successful create, so the surface can refetch. */
  onCreated?: () => void;
}

let current: NewIssueContext | null = null;

/** The context in scope right now, or null when nothing has published one. */
export function getNewIssueContext(): NewIssueContext | null {
  return current;
}

export function setNewIssueContext(ctx: NewIssueContext | null): void {
  current = ctx;
}

/**
 * Retract `ctx`, but only if it is still the published one. Two surfaces can
 * overlap for a render during a navigation — the arriving one publishes before
 * the leaving one's cleanup runs — and an unconditional clear would leave the
 * palette with no context at all.
 */
export function clearNewIssueContext(ctx: NewIssueContext): void {
  if (current === ctx) current = null;
}

/** The palette row's label for a published context. */
export function newIssueActionLabel(ctx: NewIssueContext): string {
  return `New issue in ${ctx.scopeLabel}`;
}
