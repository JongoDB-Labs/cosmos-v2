// @vitest-environment jsdom
//
// Reported: users had to zoom the browser to 75% to see the whole "New issue"
// dialog — first on Windows, then on a smaller macOS screen.
//
// The popup is centered with -translate-y-1/2, so a dialog taller than the
// viewport hangs off BOTH edges — header and submit button equally unreachable,
// with no scroll to get to them. Only the mobile bottom-sheet branch capped its
// height; the desktop branch did not.
//
// The trigger is available CSS height, not platform. Windows just meets the
// condition more often (125–150% display scaling leaves a 1080p panel reporting
// ~864 or ~720 CSS pixels), but a short laptop or a part-height browser window
// gets there too. Eight dialogs had already hand-rolled `max-h-[90vh]
// overflow-y-auto` individually, which is the tell that the base was wrong.
//
// These assert the cap is VIEWPORT-relative, which is what makes it independent
// of screen size rather than tuned for one class of machine.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

afterEach(cleanup);

function renderDialog(className?: string) {
  return render(
    <Dialog open>
      <DialogContent className={className}>
        <DialogTitle>Tall form</DialogTitle>
      </DialogContent>
    </Dialog>,
  );
}

describe("DialogContent sizing", () => {
  it("caps its height to the viewport and scrolls inside", () => {
    renderDialog();
    const content = screen.getByRole("dialog");

    // Without BOTH, a tall dialog is simply unreachable at either end.
    expect(content.className).toMatch(/max-h-\[calc\(100dvh-2rem\)\]/);
    expect(content.className).toContain("overflow-y-auto");
  });

  it("still lets a dialog opt into its own height", () => {
    // Several dialogs set max-h-[90vh] themselves; twMerge must let theirs win
    // rather than leaving two competing max-heights on the element.
    renderDialog("max-h-[90vh]");
    const content = screen.getByRole("dialog");

    expect(content.className).toContain("max-h-[90vh]");
    expect(content.className).not.toMatch(/max-h-\[calc\(100dvh-2rem\)\]/);
    // The scroll behaviour survives the override — that is the half that makes
    // the capped height usable.
    expect(content.className).toContain("overflow-y-auto");
  });
});
