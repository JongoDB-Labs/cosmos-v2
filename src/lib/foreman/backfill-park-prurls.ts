// Pure selection logic for the legacy park-PR backfill (see
// scripts/foreman/backfill-park-prurls.mts): given one work item's raw event
// history, pick the park event that still needs its `data.prUrl` patched in.
// The event chosen is the SAME one status-read.ts surfaces to gate the console's
// Approve button — observe.pickParkEvent (the newest event carrying a reason,
// else the newest of any kind), NOT merely the newest parked-kind event. Both
// call sites select through that one helper, so the script can never patch an
// event the console isn't reading. A park recorded before the `prUrl` field
// existed leaves Approve disabled even though a draft PR exists on `auto/<KEY>`;
// the script this feeds resolves that PR via `gh` and writes it back here. No
// I/O in this module; kept in src/lib so vitest can import it directly (the
// sibling .mts script pulls real event rows from Postgres and shells out to
// `gh`, neither of which belongs in a unit test).
import { pickParkEvent } from "@/lib/foreman/observe";

export type ParkEventInput = { id: string; kind: string; ts: Date; data: unknown };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The park event the console surfaces (observe.pickParkEvent — newest reasoned,
 *  else newest of any kind) with its `data` normalized to a plain object — or
 *  null when there is no park event at all, or that event already carries a
 *  non-empty string `data.prUrl` (nothing to patch, matches the console's own
 *  Approve gate). `data` that isn't a plain object (null, a bare string/number,
 *  an array — anything a malformed/legacy write could have left behind) is
 *  tolerated as `{}` rather than thrown on, since a legacy event predating the
 *  field is exactly the case this backfill exists for. */
export function latestParkNeedingPr(
  events: ParkEventInput[],
): { id: string; data: Record<string, unknown> } | null {
  const ev = pickParkEvent(events);
  if (!ev) return null;

  const data = isPlainObject(ev.data) ? ev.data : {};
  const prUrl = data.prUrl;
  if (typeof prUrl === "string" && prUrl.length > 0) return null;

  return { id: ev.id, data };
}

export type PrBackfillDecision =
  | { kind: "patch"; url: string; state: string }
  | { kind: "closed" }
  | { kind: "no-url" };

/** PR-state gate for the backfill: given a resolved PR's `url` + `state`, decide
 *  what the script should do. Only an OPEN or MERGED PR lights the console's
 *  Approve meaningfully, so only those are patched; a PR CLOSED without merge
 *  means the parked build is dead — skip it (the operator should rebuild) rather
 *  than wire a dead PR onto Approve. A missing/blank url is treated as "no PR".
 *  State is matched case-insensitively and FAILS CLOSED — anything that isn't
 *  OPEN/MERGED (including an unknown/empty state) is treated as closed, so an
 *  unrecognized state can never wrongly light Approve. Pure, so the gate is
 *  unit-tested without shelling `gh`. */
export function decidePrBackfill(pr: {
  url: string | null | undefined;
  state: string | null | undefined;
}): PrBackfillDecision {
  const url = typeof pr.url === "string" ? pr.url.trim() : "";
  if (url.length === 0) return { kind: "no-url" };
  const state = (pr.state ?? "").toUpperCase();
  if (state === "OPEN" || state === "MERGED") return { kind: "patch", url, state };
  return { kind: "closed" };
}
