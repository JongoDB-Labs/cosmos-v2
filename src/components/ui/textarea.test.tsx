import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { Textarea, TEXTAREA_MIN_ROWS, textareaMinHeight } from "./textarea";

/**
 * The reported defect: a Notes box one line deep, so you cannot read back what
 * you typed. Every "Notes" field in the app (meetings, contracts, CRM, the PM
 * trackers, compliance) is this primitive, so the resting depth is asserted
 * here — on BOTH paths, because a browser uses one or the other:
 * `rows` where `field-sizing: content` is unsupported, the `min-height` floor
 * where it is (there, `rows` is ignored and an empty field is one line tall).
 *
 * jsdom does no layout, so these assert the sizing CONTRACT the browser reads,
 * not pixels.
 */
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
    // Every "Notes" field in the trackers/dialogs asks for 2–3 rows today.
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
    expect(screen.getByLabelText("Notes").className).toContain("min-h-24");
  });

  it("keeps a caller's own min-height instead of stacking two floors", () => {
    render(<Textarea aria-label="Notes" className="min-h-32" />);

    const el = screen.getByLabelText("Notes");
    expect(el.className).toContain("min-h-32");
    expect(el.className).not.toContain("min-h-24");
  });

  it("pins a deeper box's min-height to the same lines it asked for", () => {
    expect(textareaMinHeight(10)).toBe("calc(10 * 1lh + 1rem + 2px)");
    // At or below the floor the base class already covers it — no inline style,
    // which would otherwise beat a caller's `min-h-*` class.
    expect(textareaMinHeight(TEXTAREA_MIN_ROWS)).toBeUndefined();
    expect(textareaMinHeight(1)).toBeUndefined();
  });
});
