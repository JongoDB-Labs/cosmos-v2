// @vitest-environment jsdom
//
// COSMOS-173 — a Select inside a Dialog could take the whole dialog down.
//
// NOT by the route the ticket guessed. Picking an option was never able to
// dismiss a modal dialog: base-ui only treats a press as an outside press when
// the target IS the dialog's backdrop, or an ancestor of its popup that is not
// a base-ui portal (@base-ui/react/dialog/root/useDialogRoot.js). A portalled
// option is neither, so that path is already closed — which is why a test that
// clicks an option and asserts the dialog survived passes with or without any
// fix, and is not evidence of one.
//
// The press that DID kill the dialog was one that missed the option list. A
// modal Select renders an invisible full-viewport "internal backdrop"
// (position:fixed, inset:0, NO z-index) next to its popup, whose whole job is
// to absorb that press so it closes the list and nothing else. Inside a Dialog
// the Select portals into the DIALOG's portal element, so that backdrop shares
// a stacking context with DialogOverlay, which we paint at z-50. Auto loses to
// 50, so the select's backdrop was painted UNDERNEATH the dialog's overlay and
// never received the press — the overlay did, and the dialog dismissed with an
// unsaved draft still in it.
//
// jsdom paints nothing and does no hit-testing, so it cannot decide which
// element a coordinate lands on. What it CAN pin is the arrangement the fix
// establishes — the nesting, the document order and the stacking classes that
// decide the winner — and the existence of the backdrop doing the absorbing.
// Each fails if the fix is reverted or the Select stops being modal. Which
// element a real press actually reaches is asserted in Chromium, in
// e2e/feedback-dialog-dropdown.spec.ts.
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// --- base-ui needs these in jsdom ---
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
for (const m of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture"] as const) {
  if (!Element.prototype[m]) {
    // @ts-expect-error — no-op pointer-capture stubs for jsdom
    Element.prototype[m] = () => {};
  }
}

afterEach(cleanup);

/** Open a Select rendered inside a Dialog and hand back the moving parts. */
async function openSelectInDialog() {
  const user = userEvent.setup();
  render(
    <Dialog open>
      <DialogContent>
        <DialogTitle>Draft</DialogTitle>
        <Select defaultValue="FEATURE">
          <SelectTrigger aria-label="Type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="FEATURE">Feature request</SelectItem>
            <SelectItem value="BUG">Bug report</SelectItem>
          </SelectContent>
        </Select>
      </DialogContent>
    </Dialog>,
  );

  await user.click(screen.getByLabelText("Type"));
  await screen.findByRole("option", { name: "Bug report" });

  return {
    user,
    dialogPortal: document.querySelector<HTMLElement>("[data-slot='dialog-portal']")!,
    selectPortal: document.querySelector<HTMLElement>("[data-slot='select-portal']")!,
    overlay: document.querySelector<HTMLElement>("[data-slot='dialog-overlay']")!,
  };
}

describe("SelectContent stacking inside a Dialog (COSMOS-173)", () => {
  it("portals the option list into the dialog's own portal", async () => {
    const { dialogPortal, selectPortal } = await openSelectInDialog();

    // This is WHY a z-index is needed at all: the select's layers and the
    // dialog's are ordered against each other inside one stacking context,
    // rather than being independent.
    expect(dialogPortal).toBeTruthy();
    expect(selectPortal).toBeTruthy();
    expect(dialogPortal.contains(selectPortal)).toBe(true);
  });

  it("raises that portal to the dialog overlay's stacking level", async () => {
    const { selectPortal, overlay } = await openSelectInDialog();

    // `relative` is load-bearing: z-index does nothing on a statically
    // positioned element, so without it the class is inert and the bug is back.
    expect(selectPortal.className.split(/\s+/)).toEqual(
      expect.arrayContaining(["relative", "z-50"]),
    );
    // Pinned against the overlay it has to beat, so this fails if the overlay
    // is ever raised past it rather than silently becoming wrong.
    expect(overlay.className).toContain("z-50");
  });

  it("places it after the overlay, so an equal z-index resolves in its favour", async () => {
    const { overlay, selectPortal } = await openSelectInDialog();

    expect(
      overlay.compareDocumentPosition(selectPortal) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("still renders the press-absorbing backdrop the fix relies on", async () => {
    const { selectPortal } = await openSelectInDialog();

    // Only a MODAL select renders it. Drop the modality and there is nothing
    // above the dialog's overlay to catch the press, whatever the z-index says.
    const backdrop = selectPortal.querySelector<HTMLElement>("[data-base-ui-inert]");
    expect(backdrop).toBeTruthy();
    expect(backdrop!.style.position).toBe("fixed");
    expect(backdrop!.style.inset).toBe("0px");
  });

  it("does not dismiss the dialog when that backdrop takes the press", async () => {
    const { user, selectPortal } = await openSelectInDialog();
    const dialog = screen.getByRole("dialog");

    await user.click(selectPortal.querySelector<HTMLElement>("[data-base-ui-inert]")!);

    // The press belongs to the select. The dialog behind it was not
    // outside-pressed, so it — and anything unsaved in it — stays.
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByText("Draft")).toBeInTheDocument();
  });
});
