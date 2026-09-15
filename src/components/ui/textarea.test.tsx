// COSMOS-158 — the reported defect: "The Notes input box is one line deep …
// you can not clearly see what has been input, until you go into edit mode".
//
// Every field labelled Notes in the product (meetings, contracts, CRM contacts,
// partners, compliance, the PM trackers and their entity drawer) is this one
// primitive, so its sizing contract is asserted here. Both paths are covered,
// because which one a browser takes is not the call site's choice: `rows` where
// `field-sizing: content` is unsupported, `min-height` where it is supported
// (there `rows` is ignored outright and an empty field is one line tall — the
// defect).
//
// The contract has three tiers, most explicit first, and the tests below pin
// each one INCLUDING what the primitive must NOT do — a default that quietly
// became a floor would deepen the compact composers (the retro board's
// Enter-to-submit box, the PM drawer's inline comment editor) that deliberately
// ask to stay small.
//
// jsdom does no layout, so these assert the sizing CONTRACT handed to the
// browser, not rendered pixels.
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { Textarea, TEXTAREA_DEFAULT_ROWS, textareaMinHeight } from "./textarea";

/** The CSSOM re-serializes `calc()`, so compare against a parsed probe. */
function asCss(minHeight: string): string {
  const probe = document.createElement("div");
  probe.style.minHeight = minHeight;
  expect(probe.style.minHeight).not.toBe(""); // i.e. the expression parses
  return probe.style.minHeight;
}

function notes(): HTMLTextAreaElement {
  return screen.getByLabelText<HTMLTextAreaElement>("Notes");
}

describe("Textarea resting depth", () => {
  afterEach(cleanup);

  it("rests at least four lines deep when the call site says nothing", () => {
    expect(TEXTAREA_DEFAULT_ROWS).toBeGreaterThanOrEqual(4);
  });

  it("gives a field with no opinion the resting depth on BOTH paths", () => {
    render(<Textarea aria-label="Notes" />);

    // `rows` for a browser without `field-sizing`…
    expect(notes().rows).toBe(TEXTAREA_DEFAULT_ROWS);
    // …and the same depth as a min-height for one with it, where `rows` is
    // ignored and an empty field would otherwise be one line tall.
    expect(notes().style.minHeight).toBe(
      asCss(textareaMinHeight(TEXTAREA_DEFAULT_ROWS)),
    );
  });

  it("never deepens a call site that asked for a compact box", () => {
    // The retro board's composer asks for two rows and submits on Enter; the
    // depth it asked for is the depth it gets, on either path.
    render(<Textarea aria-label="Notes" rows={2} />);

    expect(notes().rows).toBe(2);
    expect(notes().style.minHeight).toBe(asCss(textareaMinHeight(2)));
  });

  it("makes an explicit `rows` mean something where `rows` is ignored", () => {
    // The whole defect: `field-sizing: content` ignores `rows`, so a field that
    // asked for three lines rested at one. It now rests at the three it asked for.
    render(<Textarea aria-label="Notes" rows={3} />);

    expect(notes().style.minHeight).toBe(asCss(textareaMinHeight(3)));
  });

  it("lets a caller ask for a deeper box", () => {
    render(<Textarea aria-label="Notes" rows={10} />);

    expect(notes().rows).toBe(10);
    expect(notes().style.minHeight).toBe(asCss(textareaMinHeight(10)));
  });

  it("leaves a caller that sets its own min-height class alone on BOTH paths", () => {
    // The PM entity drawer's inline comment editor. A `min-h-*` class only wins
    // on the content-sized path, so imposing a default `rows` as well would size
    // it past that class in any browser without `field-sizing` — an escape hatch
    // you cannot actually escape through.
    render(<Textarea aria-label="Notes" className="min-h-16 resize-none" />);

    expect(notes().hasAttribute("rows")).toBe(false);
    expect(notes().style.minHeight).toBe("");
    expect(notes().className).toContain("min-h-16");
  });

  it("leaves a caller that sets its own min-height style alone too", () => {
    render(<Textarea aria-label="Notes" style={{ minHeight: 40 }} />);

    expect(notes().hasAttribute("rows")).toBe(false);
    expect(notes().style.minHeight).toBe("40px");
  });

  it("states the min-height a row count translates to", () => {
    expect(textareaMinHeight(4)).toBe("calc(4 * 1lh + 1rem + 2px)");
    expect(textareaMinHeight(10)).toBe("calc(10 * 1lh + 1rem + 2px)");
  });

  it("can be dragged taller, and only vertically, unless the caller says not to", () => {
    render(<Textarea aria-label="Notes" />);
    expect(notes().className).toContain("resize-y");

    cleanup();
    // The PM drawer's field editor pins its own size; tailwind-merge keeps it.
    render(<Textarea aria-label="Notes" className="resize-none" />);
    expect(notes().className).toContain("resize-none");
    expect(notes().className).not.toContain("resize-y");
  });
});
