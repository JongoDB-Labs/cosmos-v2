/**
 * COSMOS-205: a Story or Feature can't be created without an interval (a
 * sprint or PI) in a project that plans in intervals. Release trains plan by
 * PI, and a story with no interval falls out of every sprint view and every PI
 * roll-up without anyone noticing.
 *
 * Story is built in and sector-prefixed (`software.story`). Feature is usually
 * a custom type whose key may be bare (`feature`). See link-type-default.ts.
 */
const NEEDS_INTERVAL = ["story", "feature"];

export function requiresInterval(typeKey: string | null | undefined): boolean {
  if (!typeKey) return false;
  const k = typeKey.toLowerCase();
  return NEEDS_INTERVAL.some((t) => k === t || k.endsWith(`.${t}`));
}

export const INTERVAL_REQUIRED_MESSAGE =
  "Pick an interval (sprint or PI) — a Story or Feature can't be created without one.";
