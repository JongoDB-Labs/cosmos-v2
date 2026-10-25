// @vitest-environment jsdom
// Every opener drives "New issue" through `open`, not a Dialog.Trigger, so
// base-ui had no trigger to hand focus back to: closing dropped focus on
// <body> and a keyboard user started over from the top of the page.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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

vi.mock("@/hooks/use-work-item-types", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-work-item-types")>()),
  useWorkItemTypes: vi.fn(),
}));
vi.mock("@/hooks/use-custom-fields", () => ({ useCustomFields: vi.fn() }));
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch: vi.fn(() => Promise.resolve([])) }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { CreateWorkItemDialog } from "./create-work-item-dialog";
import { useWorkItemTypes } from "@/hooks/use-work-item-types";
import { useCustomFields } from "@/hooks/use-custom-fields";

beforeEach(() => {
  vi.mocked(useCustomFields).mockReturnValue({ fields: [] } as never);
  vi.mocked(useWorkItemTypes).mockReturnValue({
    types: [{ id: "t1", key: "software.task", name: "Task" }],
  } as never);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** A plain button that opens the dialog through `open`, as every caller does. */
function Opener() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        New issue
      </button>
      <CreateWorkItemDialog
        orgId="o1"
        open={open}
        onOpenChange={setOpen}
        projects={[{ id: "p1", key: "P1", name: "P1", sector: null }]}
        prefilledProjectId="p1"
      />
    </>
  );
}

describe("New issue dialog focus", () => {
  it("returns focus to the button that opened it when it closes", async () => {
    const user = userEvent.setup();
    render(<Opener />);
    const opener = screen.getByRole("button", { name: "New issue" });
    opener.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog", { name: "New issue" });

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
