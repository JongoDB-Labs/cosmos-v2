// The walkthrough CARD has to outrank every overlay in the app.
//
// The card is the only way to advance or leave a walkthrough. It used to sit at
// z-40, under dialogs, sheets, dropdowns and tooltips (all z-50) -- so anything
// opening on top of it stranded the reader with no visible control. The
// changelog dialog does exactly that on first load after a release, which is
// precisely when a walkthrough is most likely to be running.
//
// A rendering test cannot see this: jsdom computes no stacking contexts. What
// is checkable is the number.
//
// It has to be the CARD's number, not the file's highest. The first version of
// this test asserted Math.max over the whole file and passed with the bug put
// back, because the highlight ring alone cleared the bar. A guard that cannot
// fail is worse than none: it reports safety it never checked.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "src/components/tour/tour-card.tsx"), "utf8");

/** Source with comments removed — they name the whole ladder and would be read as classes. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .map((l) => l.replace(/\/\/.*$/, ""))
  .join("\n");

/** The z on the element carrying `marker`, which is what distinguishes card from ring. */
function zOf(marker: string): number {
  const line = code.split("\n").find((l) => l.includes(marker));
  if (!line) throw new Error(`no line carries ${marker} — did the markup change?`);
  const m = /\bz-\[?(\d+)\]?/.exec(line);
  if (!m) throw new Error(`no z-index on the line carrying ${marker}`);
  return Number(m[1]);
}

const CARD = "rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg";
const RING = "pointer-events-none fixed";

describe("the walkthrough card sits above every overlay", () => {
  it("clears dialogs, sheets, dropdowns and tooltips at z-50", () => {
    expect(zOf(CARD)).toBeGreaterThan(50);
  });

  it("clears the notes mention picker at 60 and the plugin overlays at 70 and 80", () => {
    expect(zOf(CARD)).toBeGreaterThan(80);
  });

  it("stays under the keyboard skip link at 100, which must always win", () => {
    expect(zOf(CARD)).toBeLessThan(100);
  });

  it("keeps the highlight ring below the card", () => {
    // Pointer-events-none, so being high costs nothing -- but if it outranked
    // the card it would draw its outline over the controls.
    expect(zOf(RING)).toBeLessThan(zOf(CARD));
  });
});
