import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Dates rendered during SSR must not be formatted with the runtime's locale.
 *
 * `toLocaleDateString()` — with no arguments, with `undefined`, or with the
 * literal `"default"` — formats using whatever locale and time zone the RUNTIME
 * has. The container and the browser therefore produce different text for the
 * same instant, React raises hydration error #418, and this app surfaces that to
 * the user as a "Something went wrong" toast. It was observed on the projects
 * list and fixed in the release that added `formatDateStable`.
 *
 * Unit tests cannot catch this: Testing Library renders client-only, so the
 * server/client disagreement never happens in a test. A source-level check has
 * no runtime locale, which is exactly why it can see the bug.
 *
 * SCOPE — this is deliberately a per-file allowlist rather than a blanket ban.
 * Not every `toLocale*` call is wrong, and blanket-converting would break real
 * behaviour:
 *
 *   - Chart axis labels built from LOCAL date arithmetic (`setHours(23,59,59)`,
 *     `new Date(y, m, d)`) would SHIFT a day if pinned to UTC. See
 *     `cfd-view.tsx`, `dashboard-view.tsx`, `calendar-view.tsx`.
 *   - Hover tooltips and dialog bodies never render during SSR, so they cannot
 *     mismatch. See `timeline-view.tsx`.
 *   - Timestamps must keep the viewer's local time; pinning them to UTC would
 *     show a New York user 10 PM for a 6 PM event.
 *   - `toLocaleString()` on a NUMBER has no time zone in it at all.
 *
 * So each file is added here as it is converted, and this list grows with the
 * migration. A file in this list has been reviewed and converted; a file absent
 * from it has not been, which is not the same as it being wrong.
 */
const CONVERTED = [
  "src/components/projects/project-card.tsx",
  "src/components/boards/scrum/sprint-board.tsx",
  "src/components/boards/backlog/backlog-view.tsx",
  "src/components/boards/dashboard/widgets/activity-feed.tsx",
  "src/components/boards/table/table-view.tsx",
  "src/components/work-items/card-detail-sheet.tsx",
  "src/components/work-items/updates-feed.tsx",
  "src/components/pm-dashboard/deliverable-tracker.tsx",
  "src/components/pm-dashboard/pm-entity-drawer.tsx",
  "src/components/pm-dashboard/schedule-tracker.tsx",
  // The ceremony board had BOTH halves of this bug in one feature: the header
  // pinned UTC inline while the Summary panel beside it did not, so the same
  // sprint window rendered a day apart on two tabs of the same screen.
  "src/components/boards/ceremony/ceremony-board.tsx",
  "src/components/boards/ceremony/ceremony-summary.tsx",
];

/**
 * Already correct before this migration reached them: an explicit locale AND an
 * explicit `timeZone: "UTC"`, which is the same guarantee the helpers give.
 * Listed so a later edit that drops the `timeZone` is caught, and so nobody
 * "converts" them a second time.
 */
const ALREADY_PINNED = [
  "src/components/work-items/issues-view.tsx",
  "src/components/pm-dashboard/pm-dashboard.tsx",
];

/**
 * A locale-dependent date format: no arguments, an explicit `undefined`, or
 * `"default"` — all three read the ambient locale.
 */
const AMBIENT_DATE_FORMAT = /\.toLocaleDateString\(\s*(\)|undefined|"default"|'default')/;

/**
 * Comments must be stripped before scanning. The converted files explain the
 * bug they fixed, and those explanations quote the offending call verbatim:
 *
 *     // NOT `new Date(...).toLocaleDateString()` — `date` is a Postgres DATE
 *
 * A guard that fires on its own documentation trains people to delete the
 * documentation, so it has to read code only.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "") // block and JSX {/* ... */} comments
    .replace(/(^|[^:])\/\/.*$/gm, "$1"); // line comments, but not `https://`
}

describe("converted surfaces format dates SSR-safely", () => {
  for (const file of CONVERTED) {
    describe(file, () => {
      const src = readFileSync(file, "utf8");

      it("was actually read, so a move or rename fails loudly", () => {
        // Without this, deleting a file would make its checks vacuously pass.
        expect(src.length).toBeGreaterThan(200);
      });

      it("uses a stable formatter", () => {
        expect(src).toMatch(/formatDate(Short|Medium|Long)?Stable/);
      });

      it("has no ambient-locale date formatting left", () => {
        const offenders = stripComments(src)
          .split("\n")
          .map((line, i) => ({ line: line.trim(), no: i + 1 }))
          .filter(({ line }) => AMBIENT_DATE_FORMAT.test(line));

        expect(offenders).toEqual([]);
      });
    });
  }
});

describe("surfaces that pin the time zone inline stay pinned", () => {
  for (const file of ALREADY_PINNED) {
    it(`${file} keeps timeZone: "UTC" on every date format`, () => {
      const src = stripComments(readFileSync(file, "utf8"));
      const calls = src.match(/\.toLocaleDateString\([\s\S]{0,220}?\)/g) ?? [];

      // Guards the guard: if the call disappears or is renamed, this must fail
      // rather than pass over an empty list.
      expect(calls.length).toBeGreaterThan(0);

      const unpinned = calls.filter((c) => !c.includes('timeZone: "UTC"'));
      expect(unpinned).toEqual([]);
    });
  }
});
