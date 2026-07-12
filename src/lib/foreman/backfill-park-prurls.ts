// Pure selection logic for the legacy park-PR backfill (see
// scripts/foreman/backfill-park-prurls.mts): given one work item's raw event
// history, pick the latest PARKED_EVENT_KINDS event that still needs its
// `data.prUrl` patched in. This is the SAME field status-read.ts reads off the
// newest parked-kind event to gate the console's Approve button, so a park
// recorded before that field existed leaves Approve disabled even though a
// draft PR exists on `auto/<KEY>` — the script this feeds resolves that PR via
// `gh` and writes it back here. No I/O in this module; kept in src/lib so
// vitest can import it directly (the sibling .mts script pulls real event rows
// from Postgres and shells out to `gh`, neither of which belongs in a unit test).
import { PARKED_EVENT_KINDS } from "@/lib/foreman/observe";

export type ParkEventInput = { id: string; kind: string; ts: Date; data: unknown };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The latest PARKED_EVENT_KINDS event in `events` (by `ts`), with `data`
 *  normalized to a plain object — or null when there is no parked-kind event
 *  at all, or the latest one already carries a non-empty string `data.prUrl`
 *  (nothing to patch, matches the console's own Approve gate). `data` that
 *  isn't a plain object (null, a bare string/number, an array — anything a
 *  malformed write could have left behind) is tolerated as `{}` rather than
 *  thrown on, since a legacy event predating the field is exactly the case
 *  this backfill exists for. */
export function latestParkNeedingPr(
  events: ParkEventInput[],
): { id: string; data: Record<string, unknown> } | null {
  const parkKinds: readonly string[] = PARKED_EVENT_KINDS;

  let latest: ParkEventInput | null = null;
  for (const e of events) {
    if (!parkKinds.includes(e.kind)) continue;
    if (!latest || e.ts.getTime() > latest.ts.getTime()) latest = e;
  }
  if (!latest) return null;

  const data = isPlainObject(latest.data) ? latest.data : {};
  const prUrl = data.prUrl;
  if (typeof prUrl === "string" && prUrl.length > 0) return null;

  return { id: latest.id, data };
}
