import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_SERVER_EVENT_TYPES } from "./event-types";

/**
 * Every event the server publishes must be listed in ALL_SERVER_EVENT_TYPES.
 *
 * Only the elected LEADER tab opens the EventSource; the rest receive events
 * rebroadcast from it. The leader binds one listener per name in that list, so a
 * published event missing from it is never bound, never received and never
 * rebroadcast — the feature's realtime silently does nothing, on every tab.
 *
 * The leader is usually the topbar's unread badge, which mounts on every
 * dashboard page ahead of any board and whose handlers are chat-only. So the
 * "leader happens to hold a handler for it" fallback rescues almost nothing in
 * practice: the list IS the contract.
 *
 * Found by driving a retro in two tabs — `ceremony.changed` was published and
 * never listened for. `org.created` and both `work-item-link.*` events were
 * missing too, which is what a hand-maintained registry does over time.
 *
 * A unit test cannot catch this: the hook works perfectly for any name it was
 * given. Only a diff against what the server actually publishes can see it.
 */

/** `publishToOrg(orgId, "x", …)` / `publishToUser(userId, "x", …)`. */
const PUBLISH_CALL = /publish(?:ToOrg|ToUser)\s*\([^,]+,\s*["']([a-z0-9.\-]+)["']/g;

/**
 * Walk `src/` in Node rather than shelling out.
 *
 * The first version ran `npx --no-install rg`. That passed locally purely
 * because ripgrep happens to be on my PATH, and failed in CI with "npx canceled
 * due to missing packages" — `rg` is not a dependency of this project. A test
 * whose result depends on what tools the machine happens to have is not a test.
 */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      sourceFiles(full, acc);
    } else if (
      /\.tsx?$/.test(entry.name) &&
      // Excluded: a test may publish a deliberately unknown name to prove the
      // handler ignores it.
      !/\.test\.tsx?$/.test(entry.name)
    ) {
      acc.push(full);
    }
  }
  return acc;
}

function publishedEventNames(): string[] {
  const names = new Set<string>();
  for (const file of sourceFiles("src")) {
    const src = readFileSync(file, "utf8");
    let m: RegExpExecArray | null;
    PUBLISH_CALL.lastIndex = 0;
    while ((m = PUBLISH_CALL.exec(src)) !== null) names.add(m[1]);
  }
  return [...names].sort();
}

describe("server events are all listed for rebroadcast", () => {
  const published = publishedEventNames();

  it("found publish call sites at all", () => {
    // Guards the guard. If the scan returns nothing — a rename, a moved helper,
    // ripgrep missing — every assertion below would pass over an empty set.
    expect(published.length).toBeGreaterThan(5);
  });

  it("lists every published event in ALL_SERVER_EVENT_TYPES", () => {
    const known = new Set<string>(ALL_SERVER_EVENT_TYPES);
    const missing = published.filter((n) => !known.has(n));

    // Named in the failure so the fix is obvious: add them to event-types.ts.
    expect(missing).toEqual([]);
  });
});
