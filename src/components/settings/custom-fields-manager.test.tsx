// @vitest-environment jsdom
//
// The "Required field" control was a hand-rolled role="switch" copy of
// ToggleSwitch: unnamed for a screen reader, no focus ring, and an off-state
// bg-muted track that is ≈ the card surface — the invisible pill ToggleSwitch's
// own comment records fixing.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/alpha/settings/fields",
  useParams: () => ({ orgSlug: "alpha" }),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
// The sector field-set packs fetch on their own; this test is about the dialog.
vi.mock("./sector-field-sets", () => ({ SectorFieldSets: () => null }));

import { CustomFieldsManager } from "./custom-fields-manager";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } })),
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("CustomFieldsManager", () => {
  it("uses the shared ToggleSwitch for Required field", async () => {
    render(<CustomFieldsManager orgId="o1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Add Field/ }));

    const sw = await screen.findByRole("switch", { name: "Required field" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    // bg-muted ≈ the card surface, so the OFF pill used to disappear.
    expect(sw.className).not.toContain("bg-muted");
    expect(sw.className).toContain("focus-visible:ring-2");

    fireEvent.click(sw);
    expect(
      screen.getByRole("switch", { name: "Required field" }).getAttribute("aria-checked"),
    ).toBe("true");
  });
});
