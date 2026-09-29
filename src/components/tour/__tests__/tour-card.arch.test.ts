// The tour card's footer must not grow with the number of steps.
//
// It used to render one dash per step. That read nicely at five or six and
// silently broke the card at sixty: roughly 1,200px of track inside a ~370px
// card, which pushed the Next button off the edge. The walkthrough still
// worked -- every step was correct and reachable by keyboard -- there was just
// no visible way to advance it, which is indistinguishable from broken to the
// person it was built to impress.
//
// A rendering test cannot catch this: jsdom lays nothing out, so Next was
// present in the DOM the whole time. What can be checked is the property that
// caused it -- the footer must not map over steps, and the track must be free
// to yield space to the buttons rather than crowd them out.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(process.cwd(), "src/components/tour/tour-card.tsx"), "utf8");
const footer = source.slice(source.indexOf("border-t border-"));

describe("the tour card footer is a fixed size at any tour length", () => {
  it("does not render one element per step", () => {
    expect(footer).not.toMatch(/tour\.steps\.map/);
  });

  it("gives the progress track min-w-0 so it yields to Back and Next", () => {
    // flex-1 alone is not enough: a flex item's default min-width is auto, so
    // wide content still forces the row open. min-w-0 is the part that works.
    expect(footer).toMatch(/min-w-0/);
    expect(footer).toMatch(/flex-1/);
  });

  it("still offers a way forward and a way out", () => {
    expect(footer).toMatch(/Next/);
    expect(footer).toMatch(/Done/);
    expect(footer).toMatch(/Back/);
  });
});
