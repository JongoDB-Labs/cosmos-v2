// @vitest-environment jsdom
//
// "Default Boards" — the project-wide baseline for which boards appear in the
// strip.
//
// The layout has ALWAYS read this:
//   hiddenBoardIds = tp.hiddenBoardIds ?? projectSettings.hiddenBoardIds ?? []
// but nothing ever wrote `projectSettings.hiddenBoardIds`. The mechanism existed
// with no way to set it, which is why the capability looked absent.
//
// The write must go through `settings`, which the PUT SHALLOW-MERGES, so it
// cannot clobber disabledBoardTypes sitting in the same object.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
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
for (const m of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture"] as const) {
  if (!Element.prototype[m]) {
    // @ts-expect-error — no-op pointer-capture stubs for jsdom
    Element.prototype[m] = () => {};
  }
}

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/providers/permissions-provider", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, usePermissions: () => ({ can: () => true }) };
});

import { ProjectSettingsClient } from "./project-settings-client";

const BOARDS = [
  { id: "b1", name: "Sprint Board", type: "SCRUM" },
  { id: "b2", name: "Bug Tracker", type: "KANBAN" },
];

function renderSettings(hiddenBoardIds: string[] = []) {
  return render(
    <ProjectSettingsClient
      orgId="o1"
      orgSlug="acme"
      projectId="p1"
      projectName="Apollo"
      projectKey="APL"
      projectDescription=""
      enabledFeatures={[]}
      disabledBoardTypes={["RAID"]}
      boards={BOARDS}
      hiddenBoardIds={hiddenBoardIds}
      krLinkTypeId={null}
      objectiveLinkTypeId={null}
    />,
  );
}

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

describe("Default Boards", () => {
  it("lists the project's boards with their type", async () => {
    renderSettings();
    const name = await screen.findByText("Bug Tracker");
    // Scoped to the board's own row: "Kanban" also appears in the Board Types
    // section below, so an unscoped query matches two nodes and is ambiguous.
    const row = name.closest("div")?.parentElement as HTMLElement;
    expect(within(row).getByText("Kanban")).toBeTruthy();
  });

  it("reflects an already-hidden board as off", async () => {
    renderSettings(["b2"]);
    const toggle = await screen.findByLabelText("Show Bug Tracker by default");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    const other = screen.getByLabelText("Show Sprint Board by default");
    expect(other.getAttribute("aria-checked")).toBe("true");
  });

  it("hides a board by writing settings.hiddenBoardIds", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderSettings();
    await user.click(await screen.findByLabelText("Show Bug Tracker by default"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/orgs/o1/projects/p1");
    expect(init.method).toBe("PUT");
    const body = JSON.parse(init.body);
    // Nested under `settings` so the server's shallow merge preserves
    // disabledBoardTypes; a top-level key would not be persisted at all.
    expect(body).toEqual({ settings: { hiddenBoardIds: ["b2"] } });
  });

  it("rolls the toggle back when the save fails", async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;

    renderSettings();
    const toggle = await screen.findByLabelText("Show Bug Tracker by default");
    await user.click(toggle);

    // Optimistic update must not survive a rejected write, or settings would
    // show a state the server never accepted.
    await waitFor(() =>
      expect(
        screen.getByLabelText("Show Bug Tracker by default").getAttribute("aria-checked"),
      ).toBe("true"),
    );
  });
});
