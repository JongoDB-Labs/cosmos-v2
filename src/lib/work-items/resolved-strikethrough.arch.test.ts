// @vitest-environment node
//
// Every surface that strikes out a WORK ITEM must ask `isWorkItemResolved`.
//
// WHY THIS GUARD EXISTS. `isWorkItemResolved` was written for bug 635be41c and its doc
// says it is for "the places that strike out a settled item" — plural. It then shipped
// with exactly ONE call site, the card-detail children list. So the Backlog and the
// Roadmap went on striking out on done-ness alone, and a Cancelled/OBE item sat unstruck
// beside struck Done items on both of them. The report came back a second time.
//
// That is the most-repeated defect shape in this codebase: a correct rule with one call
// site. A unit test of the predicate cannot see it — the predicate was always right. Only
// a rule about CALL SITES can, so this test reads the components themselves.
//
// It deliberately keys off `line-through`, the thing a user actually sees, rather than off
// an import or a prop name: those can be renamed, but a strikethrough is a strikethrough.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "src/components";

/**
 * Files that strike text through for a reason that has nothing to do with a work item's
 * state. An exemption for a real defect is its own hazard, so each entry says what it
 * strikes and why the work-item rule does not apply.
 */
const NOT_A_WORK_ITEM_STATE = new Map<string, string>([
  [
    "notes/editor/theme.ts",
    "A Lexical editor theme token: the strikethrough the AUTHOR applied to their own " +
      "text with the toolbar. Nothing to do with item state.",
  ],
  [
    "work-items/updates-feed.tsx",
    "Strikes the OLD value in an activity entry (`title: was X, now Y`). It is a diff " +
      "marker on a historical value, not a statement about the item.",
  ],
  [
    "pm-dashboard/pm-entity-drawer.tsx",
    "Same diff shape as updates-feed: `a.oldValue` struck beside the new one in an audit " +
      "trail.",
  ],
  [
    "boards/timeline/release-timeline-view.tsx",
    "Its rows are DELIVERABLES and MILESTONES, not work items — struck on their own " +
      "status enums (ACCEPTED/SUBMITTED, COMPLETED/MET). `isWorkItemResolved` takes a " +
      "work item and would not type-check here. If those entities gain a cancelled " +
      "state, they need the equivalent rule of their own, not this one.",
  ],
]);

/**
 * Comments stripped, because a MENTION is not a CALL.
 *
 * This is not hypothetical tidiness: the first version of this rule tested
 * `src.includes("isWorkItemResolved")`, and the fix it was written to protect carries a
 * long comment explaining `isWorkItemResolved`. So the guard passed on a mutant that had
 * deleted the import and gone back to striking on done-ness — it was matching its own
 * explanation. Mutation testing caught it; reading the file did not.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Does this file actually CALL the predicate (not merely talk about it)? */
function callsResolved(src: string): boolean {
  return /\bisWorkItemResolved\s*\(/.test(stripComments(src));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const files = walk(ROOT).map((path) => ({
  path,
  rel: path.slice(ROOT.length + 1),
  src: readFileSync(path, "utf8"),
}));

const strikers = files.filter((f) => f.src.includes("line-through"));

describe("work-item strikethroughs go through isWorkItemResolved", () => {
  it("GUARD THE GUARD: the scan actually found the components", () => {
    // An absence assertion over an empty list is the most reassuring kind of dead test.
    // If a refactor moves these files, this fails loudly rather than passing vacuously.
    expect(files.length).toBeGreaterThan(100);
    expect(strikers.length).toBeGreaterThanOrEqual(5);
  });

  it("every striking component either asks the predicate or is a named exemption", () => {
    const offenders = strikers
      .filter((f) => !callsResolved(f.src))
      .filter((f) => !NOT_A_WORK_ITEM_STATE.has(f.rel))
      .map((f) => f.rel);

    expect(
      offenders,
      "renders `line-through` without consulting isWorkItemResolved — a Cancelled/OBE " +
        "item will read as still outstanding there (bug 635be41c). Use it, or add the " +
        "file to NOT_A_WORK_ITEM_STATE with the reason it strikes something else.",
    ).toEqual([]);
  });

  it("no exemption is stale", () => {
    // An exemption for a file that no longer strikes anything is a lie that makes the next
    // reader trust the list less.
    const stale = [...NOT_A_WORK_ITEM_STATE.keys()].filter(
      (rel) => !strikers.some((f) => f.rel === rel),
    );
    expect(stale, "exemption names a file that no longer renders `line-through`").toEqual([]);
  });

  it("every exemption carries a reason", () => {
    for (const [rel, reason] of NOT_A_WORK_ITEM_STATE) {
      expect(reason.length, `${rel} needs a real reason, not a placeholder`).toBeGreaterThan(40);
    }
  });

  it("CONTROL: a mention in a comment does not count as a call", () => {
    // The exact mutant that slipped past the first version of this rule.
    const mentionsOnly = `
      // isWorkItemResolved exists for this, see its doc.
      /* isWorkItemResolved(item, columns) would be right here. */
      const isResolved = (item) => item.columnKey === "done";
      <span className={cn(resolved && "line-through")} />
    `;
    expect(mentionsOnly.includes("isWorkItemResolved")).toBe(true); // a naive rule passes
    expect(callsResolved(mentionsOnly)).toBe(false); // this one does not

    const realCall = `const isResolved = (i) => isWorkItemResolved(i, columns);`;
    expect(callsResolved(realCall)).toBe(true);
  });

  it("the two surfaces this bug was reported against are covered", () => {
    // Named explicitly, not left to the generic rule. These are the regressions: both were
    // reported, both were fixed, and a future refactor that drops the call would otherwise
    // only fail the generic rule above if someone also removed the import.
    for (const rel of ["boards/backlog/backlog-view.tsx", "boards/roadmap/roadmap-view.tsx"]) {
      const f = strikers.find((x) => x.rel === rel);
      expect(f, `${rel} should still render a strikethrough`).toBeDefined();
      expect(callsResolved(f!.src), `${rel} mentions the predicate but never calls it`).toBe(true);
    }
  });
});
