// COSMOS-158 — the reported defect: "The Notes input box is one line deep …
// you can not clearly see what has been input, until you go into edit mode".
//
// Every field labelled Notes in the product (meetings, contracts, CRM contacts,
// partners, compliance, the PM trackers and their entity drawer) is this one
// primitive, so the resting depth is asserted here rather than at eleven call
// sites. Both sizing paths are covered, because which one a browser takes is
// not the call site's choice: `rows` where `field-sizing: content` is
// unsupported, the `min-height` floor where it is supported (there `rows` is
// ignored outright and an empty field is one line tall — the defect).
//
// jsdom does no layout, so these assert the sizing CONTRACT handed to the
// browser, not rendered pixels.
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { Textarea, TEXTAREA_MIN_ROWS, textareaMinHeight } from "./textarea";

describe("Textarea resting depth", () => {
  afterEach(cleanup);

  it("rests at least four lines deep, so a note is readable while typing", () => {
    expect(TEXTAREA_MIN_ROWS).toBeGreaterThanOrEqual(4);
  });

  it("defaults `rows` to the resting depth rather than the HTML default of 2", () => {
    render(<Textarea aria-label="Notes" />);

    expect(screen.getByLabelText<HTMLTextAreaElement>("Notes").rows).toBe(
      TEXTAREA_MIN_ROWS,
    );
  });

  it("raises a caller asking for fewer rows to the resting depth", () => {
    // The Notes fields in the trackers and dialogs ask for 2–3 rows today.
    render(<Textarea aria-label="Notes" rows={2} />);

    expect(screen.getByLabelText<HTMLTextAreaElement>("Notes").rows).toBe(
      TEXTAREA_MIN_ROWS,
    );
  });

  it("lets a caller ask for a deeper box", () => {
    render(<Textarea aria-label="Notes" rows={10} />);

    expect(screen.getByLabelText<HTMLTextAreaElement>("Notes").rows).toBe(10);
  });

  it("carries the resting depth as a min-height for content-sized fields", () => {
    render(<Textarea aria-label="Notes" />);

    // The floor lives in the class list (so a caller's own `min-h-*` can win);
    // `min-h-24` is 6rem — TEXTAREA_MIN_ROWS line boxes plus `py-2` at text-sm.
    const el = screen.getByLabelText("Notes");
    expect(el.className).toContain("min-h-24");
    expect(el.className).not.toContain("min-h-16");
  });

  it("keeps a caller's own min-height instead of stacking two floors", () => {
    // The PM entity drawer's inline comment editor is deliberately compact.
    render(<Textarea aria-label="Notes" className="min-h-16" />);

    const el = screen.getByLabelText("Notes");
    expect(el.className).toContain("min-h-16");
    expect(el.className).not.toContain("min-h-24");
  });

  it("pins a deeper box's min-height to the same lines it asked for", () => {
    expect(textareaMinHeight(10)).toBe("calc(10 * 1lh + 1rem + 2px)");

    // …and the deeper box actually carries it. Compared against a probe rather
    // than the literal, because the CSSOM re-serializes `calc()` — a bare
    // string compare would assert jsdom's formatting, not the height.
    const probe = document.createElement("div");
    probe.style.minHeight = textareaMinHeight(10)!;
    expect(probe.style.minHeight).not.toBe(""); // i.e. the expression parses
    render(<Textarea aria-label="Notes" rows={10} />);
    expect(screen.getByLabelText("Notes").style.minHeight).toBe(
      probe.style.minHeight,
    );
    // At or below the floor the base class already covers it — no inline style,
    // which would otherwise beat a caller's `min-h-*` class.
    expect(textareaMinHeight(TEXTAREA_MIN_ROWS)).toBeUndefined();
    expect(textareaMinHeight(1)).toBeUndefined();
  });

  it("can be dragged taller, and only vertically", () => {
    render(<Textarea aria-label="Notes" />);

    expect(screen.getByLabelText("Notes").className).toContain("resize-y");
  });
});
