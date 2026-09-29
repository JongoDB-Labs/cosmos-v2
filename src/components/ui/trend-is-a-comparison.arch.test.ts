// @vitest-environment node
//
// A StatCard's trend must be a COMPARISON, never the number again.
//
// The org overview rendered:
//
//   <StatCard label="Active projects" trend={`+${activeProjects}`}>
//     <StatCard.Number>{activeProjects}</StatCard.Number>
//   </StatCard>
//
// TrendChip reads a leading "+" as upward and paints a green chip with a rising
// arrow -- the universal shorthand for "grew by this much since last period".
// There was no last period. The chip was the count printed a second time, so a
// practice with twenty active projects was told it had gained twenty, for ever,
// and one with five hundred would have been told it gained five hundred.
//
// It is the same mistake as reporting an untouched ledger as $0.00: a number
// the data cannot support, rendered in the visual language of a measurement.
// The other callers are honest -- they pass a verdict against a published
// benchmark, or a direction derived from overdue work -- which is why this is a
// rule about the RELATIONSHIP between the two values rather than a ban on the
// prop.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

/** <StatCard ... trend={EXPR}> ... <StatCard.Number>{EXPR}</StatCard.Number> */
const PAIR =
  /<StatCard\b[^>]*\btrend=\{([^}]*)\}[\s\S]{0,400}?<StatCard\.Number>\s*\{([^}]*)\}/g;

/** Any StatCard wrapping a Number, trend or not — used only for the floor. */
const ANY_CARD = /<StatCard\b[\s\S]{0,400}?<StatCard\.Number>/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(entry)) out.push(full);
  }
  return out;
}

/** The bare identifiers an expression mentions, ignoring property paths. */
function identifiers(expr: string): string[] {
  return [...expr.matchAll(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)].map((m) => m[0]);
}

describe("StatCard trend", () => {
  it("is never just the displayed number wearing a plus sign", () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "src"))) {
      const rel = relative(ROOT, file);
      if (/\.(test|spec)\.tsx$/.test(rel) || rel.includes("__tests__")) continue;
      // The design-system gallery and the branding preview exist to SHOW the
      // chip; their numbers are literals with no relationship to anything.
      if (rel.includes("design-system") || rel.includes("__examples__")) continue;
      if (rel.includes("org-branding-section")) continue;

      for (const [, trend, number] of readFileSync(file, "utf8").matchAll(PAIR)) {
        const shown = new Set(identifiers(number));
        if (identifiers(trend).some((id) => shown.has(id))) {
          offenders.push(`${rel}: trend={${trend.trim()}} beside {${number.trim()}}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("still finds StatCards to check", () => {
    // Guard the guard: if the JSX shape changes and the pattern stops matching,
    // the rule above silently checks nothing and looks permanently green.
    //
    // The floor is on ANY_CARD, not on the trend-carrying PAIR: most StatCards
    // pass no trend at all, so a floor on PAIR would be measuring how many
    // cards happen to use the prop — which is exactly the number this fix just
    // reduced. That version failed the moment the bug was removed, which is the
    // wrong thing for a guard to notice.
    let cards = 0;
    for (const file of walk(join(ROOT, "src"))) {
      cards += [...readFileSync(file, "utf8").matchAll(ANY_CARD)].length;
    }
    expect(cards).toBeGreaterThan(5);
  });
});
