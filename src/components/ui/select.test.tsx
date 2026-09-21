// @vitest-environment jsdom
//
// COSMOS-173 — a Select inside a Dialog could take the whole dialog down.
//
// NOT by the route the ticket guessed. Picking an option was never able to
// dismiss a modal dialog: base-ui only treats a press as an outside press when
// the target IS the dialog's backdrop, or an ancestor of its popup that is not
// a base-ui portal (@base-ui/react/dialog/root/useDialogRoot.js). A portalled
// option is neither, so that path was already closed — which is why a test that
// clicks an option and asserts the dialog survived passes with or without any
// fix, and is not evidence of one.
//
// The press that DID kill the dialog was one that MISSED the option list. A
// modal Select renders an invisible full-viewport "internal backdrop"
// (position:fixed, inset:0, NO z-index) next to its popup, whose whole job is
// to absorb that press so it closes the list and nothing else. Inside a Dialog
// the Select portals into the DIALOG's portal element, so that backdrop shares
// a stacking context with DialogOverlay, which we paint at z-50. Auto loses to
// 50, so the select's backdrop was painted UNDERNEATH the dialog's overlay and
// never received the press — the overlay did, and the dialog dismissed with an
// unsaved draft still in it.
//
// WHAT THIS FILE CAN AND CANNOT PROVE. jsdom neither paints nor hit-tests: a
// click here goes to whichever element the test names, so no jsdom test can
// decide which layer a real press would reach. The falsifiable BEHAVIOUR test
// therefore lives in Chromium — e2e/feedback-dialog-dropdown.spec.ts, which
// goes red on the reverted fix. What jsdom can pin is the arrangement that
// decides the winner, and "raises that portal to the dialog overlay's stacking
// level" below also goes red on the reverted fix.
//
// The dialog is rendered with REAL open state, never a hard-coded `open`, so a
// dismissal has somewhere to land — and the first test proves this harness can
// in fact be closed, which is what stops the ones after it being vacuous.
import { describe, it, expect, afterEach } from "vitest";
import * as React from "react";
import { render, screen, cleanup, within, waitFor } from "@testing-library/react";
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

/**
 * A dialog that owns its open state, exactly as a real caller does. A dismissal
 * that reaches it actually unmounts it — with `open` pinned true it could not,
 * and every "the dialog survived" assertion below would hold trivially.
 */
function DialogWithPicker() {
  const [open, setOpen] = React.useState(true);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
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
    </Dialog>
  );
}

const overlay = () =>
  document.querySelector<HTMLElement>("[data-slot='dialog-overlay']")!;
const selectPortal = () =>
  document.querySelector<HTMLElement>("[data-slot='select-portal']")!;
const dialogPortal = () =>
  document.querySelector<HTMLElement>("[data-slot='dialog-portal']")!;

/** Render the dialog and open its picker. */
async function openPicker() {
  const user = userEvent.setup();
  render(<DialogWithPicker />);
  await user.click(screen.getByLabelText("Type"));
  await screen.findByRole("option", { name: "Bug report" });
  return user;
}

describe("SelectContent stacking inside a Dialog (COSMOS-173)", () => {
  it("is a dialog that can actually be dismissed — the control for every case below", async () => {
    const user = userEvent.setup();
    render(<DialogWithPicker />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(overlay());

    // If this ever stops closing, the assertions that follow stop meaning
    // anything and should be read as broken rather than passing.
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("portals the option list into the dialog's own portal", async () => {
    await openPicker();

    // This is WHY a z-index is needed at all: the select's layers and the
    // dialog's are ordered against each other inside ONE stacking context,
    // rather than being independent.
    expect(dialogPortal()).toBeTruthy();
    expect(selectPortal()).toBeTruthy();
    expect(dialogPortal().contains(selectPortal())).toBe(true);
  });

  it("raises that portal to the dialog overlay's stacking level", async () => {
    await openPicker();

    // `relative` is load-bearing: z-index does nothing on a statically
    // positioned element, so without it the class is inert and the bug is back.
    expect(selectPortal().className.split(/\s+/)).toEqual(
      expect.arrayContaining(["relative", "z-50"]),
    );
    // Pinned against the layer it has to beat, so raising the overlay past it
    // fails here rather than silently reopening the hole.
    expect(overlay().className).toContain("z-50");
    // Equal z-index resolves on document order, so the portal must come last.
    expect(
      overlay().compareDocumentPosition(selectPortal()) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("still renders the press-absorbing backdrop the fix relies on", async () => {
    await openPicker();

    // Only a MODAL select renders it. Drop the modality and there is nothing
    // above the dialog's overlay to catch the press, whatever the z-index says.
    const backdrop = selectPortal().querySelector<HTMLElement>("[data-base-ui-inert]");
    expect(backdrop).toBeTruthy();
    expect(backdrop!.style.position).toBe("fixed");
    expect(backdrop!.style.inset).toBe("0px");
  });

  it("does not dismiss the dialog when that backdrop takes the press", async () => {
    const user = await openPicker();
    const dialog = screen.getByRole("dialog");

    await user.click(selectPortal().querySelector<HTMLElement>("[data-base-ui-inert]")!);

    // The press belongs to the select, so the dialog behind it was not
    // outside-pressed and anything unsaved in it survives. The first test in
    // this file shows the same dialog closing, so this is a real outcome and
    // not a dialog that could never have gone away.
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(within(dialog).getByText("Draft")).toBeInTheDocument();
  });
});
