// Pure planner core for Foreman's To-do curation: the ranking prompt over backlog
// candidates, the tolerant parser that turns a model reply into promotions, and
// the predicate that respects a human demotion. No I/O — imported by the daemon
// (scripts/foreman/run.mts) and unit-tested in isolation (vitest cannot load the
// .mts daemon modules, so all pure logic lives here).

/** Number of tickets To-do is kept stocked to. */
export const PLAN_TARGET = 3;

/** How long a human demotion suppresses re-promotion, absent any new activity. */
const DEMOTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Max length of a promotion's one-line rationale. */
const WHY_MAX = 140;

/** A backlog ticket offered to the ranking pass. `feedbackType`/`severity`/
 *  `voteCount` are null when no feedback item is linked (a hand-filed ticket). */
export interface PlannerCandidate {
  key: string;
  title: string;
  description: string;
  priority: string;
  feedbackType: string | null;
  severity: string | null;
  voteCount: number | null;
  ageDays: number;
}

/** A human demotion still stands — the ticket must NOT be re-promoted — exactly
 *  while ALL hold: Foreman had promoted it (plannedAt set) strictly BEFORE the
 *  demotion, nothing has edited (updatedAt) or commented (lastCommentAt) on it
 *  since the demotion, and the demotion is younger than DEMOTION_WINDOW_MS. Any
 *  edit/comment after the demotion, or the window elapsing, re-opens it. */
export function isStandingDemotion(f: {
  plannedAt: Date | null;
  demotedAt: Date;
  updatedAt: Date;
  lastCommentAt: Date | null;
  now: Date;
}): boolean {
  if (f.plannedAt === null) return false;
  if (f.plannedAt.getTime() >= f.demotedAt.getTime()) return false;
  if (f.updatedAt.getTime() > f.demotedAt.getTime()) return false;
  if (f.lastCommentAt !== null && f.lastCommentAt.getTime() > f.demotedAt.getTime()) return false;
  if (f.now.getTime() - f.demotedAt.getTime() >= DEMOTION_WINDOW_MS) return false;
  return true;
}

/** The ranking prompt: a numbered digest of every candidate followed by a strict
 *  JSON-only output contract for exactly `slots` picks. */
export function plannerPrompt(candidates: PlannerCandidate[], slots: number): string {
  const lines = candidates.map((c, i) => {
    const desc = (c.description ?? "").slice(0, 200);
    return `${i + 1}. ${c.key} · ${c.priority} · ${c.feedbackType ?? "ticket"}/${c.severity ?? "-"} · votes:${c.voteCount ?? 0} · age:${c.ageDays}d · ${c.title}${desc ? ` — ${desc}` : ""}`;
  });
  return [
    `You are prioritizing a software team's backlog. Pick the ${slots} tickets with the highest priority/ROI — weigh user votes, severity, bug-over-cosmetic impact, and age.`,
    "",
    lines.join("\n"),
    "",
    `Reply with ONLY a JSON array: [{"key": "...", "why": "one line, ≤140 chars"}] — best first, no prose.`,
  ].join("\n");
}

/** Turn a model reply into at most `max` promotions. Tolerant by construction so a
 *  malformed answer costs nothing: locate the first bracketed array (even one
 *  wrapped in prose) by scanning to its matching close bracket, JSON.parse it in a
 *  try/catch, keep only object entries whose `key` is a string in `validKeys`,
 *  dedupe (first wins), truncate each `why` to WHY_MAX (missing → ""), and cap the
 *  result at `max`. Any parse/shape failure yields []. */
export function parsePlannerPicks(
  raw: string,
  validKeys: Set<string>,
  max: number,
): Array<{ key: string; why: string }> {
  const start = raw.indexOf("[");
  if (start === -1) return [];
  let depth = 0;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end === -1) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const picks: Array<{ key: string; why: string }> = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const key = (entry as { key?: unknown }).key;
    if (typeof key !== "string" || !validKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    const why = (entry as { why?: unknown }).why;
    picks.push({ key, why: typeof why === "string" ? why.slice(0, WHY_MAX) : "" });
    if (picks.length >= max) break;
  }
  return picks;
}
