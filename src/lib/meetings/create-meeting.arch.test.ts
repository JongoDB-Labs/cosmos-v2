import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every meeting is created through `createSyncMeeting`, which saves it and
 * pushes it to Outlook.
 *
 * The REST create pushed; Cosmo's `create_meeting` wrote the row itself and
 * didn't, so a meeting Cosmo scheduled reached nobody's calendar until the next
 * reconcile. Both now share one path. A create written anywhere else would
 * bring the gap back silently, so this fails on it instead.
 */
const HELPER = "src/lib/meetings/create-meeting.server.ts";

/** `prisma.syncMeeting.create(`, `tx.syncMeeting.upsert(` and the like, across lines. */
const CREATES = /\.\s*syncMeeting\s*\.\s*(create|createMany|createManyAndReturn|upsert)\s*\(/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Tests and their fixtures build meetings directly, as fixtures do.
      if (entry.name !== "__tests__") out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes(".test.")) {
      out.push(full.split("\\").join("/"));
    }
  }
  return out;
}

/** Comments out, so prose that names a create neither trips nor satisfies the rule. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("meetings are created only through createSyncMeeting", () => {
  const creators = walk("src").filter((f) => CREATES.test(code(readFileSync(f, "utf8"))));

  it("the scan sees a real create, so an empty result means something", () => {
    expect(creators).toContain(HELPER);
    // The pattern spans lines, as a formatted call does.
    expect(CREATES.test("prisma.syncMeeting\n  .create({")).toBe(true);
    expect(CREATES.test("prisma.syncMeeting.update({")).toBe(false);
  });

  it("no other file in the app creates one", () => {
    expect(creators.filter((f) => f !== HELPER)).toEqual([]);
  });
});
