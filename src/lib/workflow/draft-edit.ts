/**
 * Edits to a workflow draft, as the editor's views make them. Pure and
 * client-safe: every view (statuses list, matrix, canvas, transition panel)
 * changes the one draft through these, so they agree by construction.
 */
import type { TransitionSpec, WorkflowDefinition } from "@/lib/workflow/definition";

/** A transition with nothing on it but the move: what a matrix checkbox makes. */
export function isPlainTransition(t: TransitionSpec): boolean {
  return !t.restrict && !t.input?.length && !t.validate?.length && !t.actions?.length && !t.hidden;
}

/** Whether `t` leads from `from` (a global transition leads from everywhere). */
export function leadsFrom(t: TransitionSpec, from: string): boolean {
  return t.from === "*" || t.from.includes(from);
}

export interface CellState {
  /** Some transition takes an item from `from` to `to`. */
  allowed: boolean;
  /** The transitions that do, named ones first. */
  via: TransitionSpec[];
  /** Only a global transition does. */
  onlyGlobal: boolean;
}

/** The matrix cell (from, to). */
export function cellState(def: WorkflowDefinition, from: string, to: string): CellState {
  const via = def.transitions
    .filter((t) => t.to === to && leadsFrom(t, from))
    .sort((a, b) => Number(a.from === "*") - Number(b.from === "*"));
  return { allowed: via.length > 0, via, onlyGlobal: via.length > 0 && via.every((t) => t.from === "*") };
}

/** An id not yet used in `def`, from `base`. */
export function freshTransitionId(def: WorkflowDefinition, base: string): string {
  const taken = new Set(def.transitions.map((t) => t.id));
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 56) || "t";
  if (!taken.has(slug)) return slug;
  for (let i = 2; ; i++) if (!taken.has(`${slug}-${i}`)) return `${slug}-${i}`;
}

const withTransitions = (def: WorkflowDefinition, transitions: TransitionSpec[]): WorkflowDefinition => ({ ...def, transitions });

/**
 * Allow or disallow the move from `from` to `to`. Allowing joins a plain
 * transition already into `to`, or adds one named after the status;
 * disallowing takes `from` out of every transition covering the cell (a global
 * one becomes "from every other status") and drops any left leading from nowhere.
 */
export function setMove(
  def: WorkflowDefinition,
  from: string,
  to: string,
  allowed: boolean,
  nameOf: (key: string) => string = (k) => k,
): WorkflowDefinition {
  if (from === to) return def;
  const cell = cellState(def, from, to);
  if (allowed) {
    if (cell.allowed) return def;
    const join = def.transitions.find((t) => t.to === to && t.from !== "*" && isPlainTransition(t));
    if (join) {
      return withTransitions(def, def.transitions.map((t) => (t === join ? { ...t, from: [...(t.from as string[]), from] } : t)));
    }
    const id = freshTransitionId(def, `${from}-to-${to}`);
    return withTransitions(def, [...def.transitions, { id, name: nameOf(to), from: [from], to }]);
  }
  if (!cell.allowed) return def;
  const keys = def.statuses.map((s) => s.key);
  const next = def.transitions.flatMap((t): TransitionSpec[] => {
    if (t.to !== to || !leadsFrom(t, from)) return [t];
    const sources = (t.from === "*" ? keys.filter((k) => k !== to) : t.from).filter((k) => k !== from);
    return sources.length > 0 ? [{ ...t, from: sources }] : [];
  });
  return withTransitions(def, next);
}

/** "Allow from any status" into `to`: one global transition, or none. */
export function setGlobal(def: WorkflowDefinition, to: string, on: boolean, nameOf: (key: string) => string = (k) => k): WorkflowDefinition {
  const existing = def.transitions.find((t) => t.to === to && t.from === "*");
  if (on) {
    if (existing) return def;
    return withTransitions(def, [...def.transitions, { id: freshTransitionId(def, to), name: nameOf(to), from: "*", to }]);
  }
  if (!existing) return def;
  return withTransitions(def, def.transitions.filter((t) => t !== existing));
}

/** Make `key` the status new items start in. */
export function setInitial(def: WorkflowDefinition, key: string): WorkflowDefinition {
  return {
    ...def,
    statuses: def.statuses.map(({ isInitial: _drop, ...s }) => (s.key === key ? { ...s, isInitial: true as const } : s)),
  };
}

/** Use one of the project's statuses in this workflow (reachable from anywhere, to start with). */
export function includeStatus(def: WorkflowDefinition, key: string, nameOf: (key: string) => string = (k) => k): WorkflowDefinition {
  if (def.statuses.some((s) => s.key === key)) return def;
  return setGlobal({ ...def, statuses: [...def.statuses, { key }] }, key, true, nameOf);
}

/**
 * Stop using a status: the transitions into it go, and it leaves every
 * transition's sources. A transition left with no source goes too. The initial
 * status moves to the first one left when it was this one.
 */
export function excludeStatus(def: WorkflowDefinition, key: string): WorkflowDefinition {
  const wasInitial = def.statuses.find((s) => s.key === key)?.isInitial;
  const statuses = def.statuses.filter((s) => s.key !== key);
  const transitions = def.transitions.flatMap((t): TransitionSpec[] => {
    if (t.to === key) return [];
    if (t.from === "*") return [t];
    const from = t.from.filter((f) => f !== key);
    return from.length > 0 ? [{ ...t, from }] : [];
  });
  const next = { ...def, statuses, transitions };
  return wasInitial && statuses.length > 0 ? setInitial(next, statuses[0].key) : next;
}

/** Add or replace (by id) a transition; `previousId` renames one in place. */
export function upsertTransition(def: WorkflowDefinition, t: TransitionSpec, previousId: string = t.id): WorkflowDefinition {
  const i = def.transitions.findIndex((x) => x.id === previousId);
  if (i === -1) return withTransitions(def, [...def.transitions, t]);
  const transitions = [...def.transitions];
  transitions[i] = t;
  return withTransitions(def, transitions);
}

export function removeTransition(def: WorkflowDefinition, id: string): WorkflowDefinition {
  return withTransitions(def, def.transitions.filter((t) => t.id !== id));
}
