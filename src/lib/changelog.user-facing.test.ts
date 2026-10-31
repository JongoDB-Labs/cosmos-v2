import { describe, it, expect } from "vitest";

import { CHANGELOG } from "./changelog";

/**
 * COSMOS-237. `WhatsNewModal` renders each highlight's `text` verbatim
 * (`whats-new-modal.tsx`) and AUTO-OPENS for every real user whose last-seen
 * version predates the running one — so a changelog string is shipped UI, not
 * a release note someone opts into reading.
 *
 * The 2.505.1 entry originally ended with a parenthetical addressed to the
 * engineer reviewing the PR: "(Assumed approach, pending review: filter the
 * message out of error reporting rather than change how transitions are run.)"
 * It read fine in the diff and shipped an internal workflow state to every
 * customer's screen.
 *
 * This guards the CLASS, not that one string. Note what it deliberately does
 * NOT ban: "reviewer", "for review", "assumed" and ticket-key syntax
 * ("ACME-320") all appear legitimately in shipped entries, because code review
 * is a product feature here and ticket keys are something users type. So do
 * "internal notes" (the staff-only notes on a feedback item, 2.453.0) and "WIP
 * limit" (a Kanban column's cap) — both were tried here and both fired on
 * correct copy. Banning any of those would be a test that cries wolf on good
 * writing, which gets the whole file ignored. What is banned is engineering
 * PROCESS state — language that only means something to whoever is merging the
 * branch.
 */
const INTERNAL_PROCESS = [
  ["pending review", /pending review/i],
  ["pending human", /pending human/i],
  ["assumed approach", /assumed approach/i],
  ["awaiting review", /awaiting review/i],
  ["note to reviewer", /note (?:to|for) (?:the )?reviewer/i],
  ["TODO", /\bTODO\b/],
  ["FIXME", /\bFIXME\b/],
  ["do not ship", /do ?n[o']?t ship/i],
] as const;

describe("CHANGELOG is user-facing copy", () => {
  const strings = CHANGELOG.flatMap((r) => [
    { version: r.version, where: "title", value: r.title },
    ...r.highlights.map((h) => ({ version: r.version, where: "text", value: h.text })),
  ]);

  it("has strings to check (guards against a vacuous pass)", () => {
    expect(strings.length).toBeGreaterThan(100);
  });

  it.each(INTERNAL_PROCESS)(
    "no entry leaks the internal-process phrase %s into the What's new modal",
    (_label, pattern) => {
      const offenders = strings
        .filter((s) => pattern.test(s.value))
        .map((s) => `${s.version} (${s.where}): ${s.value.slice(0, 120)}`);
      expect(offenders).toEqual([]);
    },
  );

  it("still allows an assumption stated in product terms, as 2.371.0 does", () => {
    // The convention this repo already uses when a ticket was ambiguous: say
    // what was assumed in terms of observable behaviour. That must keep working
    // — the ban above is on process chatter, not on disclosure.
    const assumed = strings.filter((s) => /^ASSUMED, and worth confirming:/.test(s.value));
    expect(assumed.length).toBeGreaterThan(0);
    for (const s of assumed) {
      for (const [, pattern] of INTERNAL_PROCESS) expect(pattern.test(s.value)).toBe(false);
    }
  });
});
