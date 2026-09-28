/**
 * The changelog has exactly one audience: the people using the product.
 *
 * It is not a place to leave a note for whoever reviews the change that added
 * the entry. Two surfaces make that mistake expensive rather than merely untidy:
 *
 * - `whats-new-modal.tsx` OPENS BY ITSELF on the first load after a release
 *   (`lastSeen !== CURRENT_VERSION` → `setOpen(true)`) and renders `{h.text}`
 *   verbatim, with no truncation. A reviewer-directed aside is therefore shown
 *   to every signed-in user, full length, unprompted.
 * - `release.yml` publishes the entry as a `<version>-notes` OCI artifact so the
 *   Updates page can read notes for a version it has not installed. Once pushed
 *   it is outside the app entirely, and deleting the tag does not unpublish it.
 *
 * Caught on CLEANUP-6, where an entry carried "(Note for review: … one file
 * outside the ticket's stated scope …)" — addressed to a reviewer, shipped to
 * users. Where a change needs a note to its reviewer, the commit message is the
 * place; it reaches the reviewer and nobody else.
 *
 * The patterns below are deliberately narrow. Words like "ticket", "commit",
 * "pull request" and "reviewer" appear legitimately and often in these entries,
 * because Foreman itself is a product feature described to users here — banning
 * the vocabulary would be wrong. What is banned is ADDRESSING the reviewer.
 */
import { describe, it, expect } from "vitest";
import { CHANGELOG } from "./changelog";

/** Asides aimed at whoever reviews the change, not at whoever uses the product. */
const REVIEWER_DIRECTED: { re: RegExp; why: string }[] = [
  { re: /note\s+(?:for|to)\s+(?:review|reviewers?)/i, why: "a note addressed to the reviewer" },
  { re: /\bfor review:/i, why: "an aside addressed to review" },
  { re: /\bplease\s+(?:confirm|review|note|check)\b/i, why: "an instruction to the reviewer" },
  { re: /\boutside the ticket\b/i, why: "this change's own scope negotiation" },
  { re: /\bstated scope\b/i, why: "this change's own scope negotiation" },
  { re: /\bout of scope\b/i, why: "this change's own scope negotiation" },
];

const prose = (): { where: string; text: string }[] =>
  CHANGELOG.flatMap((r) => [
    { where: `${r.version} title`, text: r.title },
    ...r.highlights.map((h, i) => ({ where: `${r.version} highlight ${i}`, text: h.text })),
  ]);

describe("CHANGELOG entries address users, never the reviewer", () => {
  it("has prose to check at all — anti-vacuity", () => {
    expect(prose().length).toBeGreaterThan(200);
  });

  for (const { re, why } of REVIEWER_DIRECTED) {
    it(`contains no ${why} (${re.source})`, () => {
      const offenders = prose()
        .filter(({ text }) => re.test(text))
        .map(({ where, text }) => `${where}: ${text.slice(0, 160)}…`);
      expect(
        offenders,
        `The What's New modal auto-opens this text for every signed-in user and it is published as a release-notes artifact. Put the note in the commit message instead:\n${offenders.join("\n")}`,
      ).toEqual([]);
    });
  }

  it("the patterns actually match the shape they are meant to catch", () => {
    // Tested on crafted input, not on the real data: today's entries are clean,
    // so a matcher that matched nothing at all would pass every case above.
    const planted =
      "The descriptions now match what the importer does. (Note for review: this " +
      "also touched one file outside the ticket's stated scope, because it would " +
      "not compile otherwise.)";
    expect(REVIEWER_DIRECTED.filter(({ re }) => re.test(planted)).length).toBeGreaterThanOrEqual(3);
    // …and leave ordinary product prose about Foreman's own tickets alone.
    const legitimate =
      "Foreman opens one cleanup ticket per batch, and the work comes back as a " +
      "pull request for review before anything ships.";
    expect(REVIEWER_DIRECTED.filter(({ re }) => re.test(legitimate))).toEqual([]);
  });
});
