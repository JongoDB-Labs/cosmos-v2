// @vitest-environment jsdom
//
// #36 — "the project Members section does not work".
//
// It looks like it works, which is why it was reported that way. `setRole`
// catches its own failure and returns normally, so `add()` carried on to clear
// the form and fire toast.success("Member added to project.") regardless. On a
// failed add the user saw an error toast AND a success toast, an emptied form,
// and no new row — indistinguishable from "the button does nothing".
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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

vi.mock("next/navigation", () => ({ usePathname: () => "/acme/projects/P1/members" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/lib/query/json-fetcher", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/query/json-fetcher")>();
  return { ...actual, jsonFetch: vi.fn() };
});

import { ProjectMembersManager } from "./project-members-manager";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { toast } from "sonner";
import { notifyError } from "@/lib/errors/notify";

const ORG_MEMBERS = [
  { id: "om1", user: { displayName: "Alice", email: "alice@x.io", avatarUrl: null } },
  { id: "om2", user: { displayName: "Bob", email: "bob@x.io", avatarUrl: null } },
];

function renderManager() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProjectMembersManager
        orgId="11111111-1111-1111-1111-111111111111"
        projectId="22222222-2222-2222-2222-222222222222"
        projectName="Apollo"
        canManage
      />
    </QueryClientProvider>,
  );
}

/** Pick the first addable person in the "Add member" combobox. */
async function chooseFirstPerson(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByLabelText("Add member"));
  await user.click(await screen.findByText(/Alice/));
}

// Stubbing globalThis.fetch without restoring it leaks into every other test
// file sharing this worker — which showed up as unrelated DB specs failing, a
// DIFFERENT one on each run depending on execution order. Capture and restore.
const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  // Project has no members yet; the org has two people to add.
  vi.mocked(jsonFetch).mockImplementation(((url: string) =>
    url.includes("/projects/")
      ? Promise.resolve([])
      : Promise.resolve(ORG_MEMBERS)) as unknown as typeof jsonFetch);
});
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

describe("ProjectMembersManager — adding a member that fails", () => {
  it("does not claim success when the request fails", async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "That person isn't a member of this organization." }),
    }) as unknown as typeof fetch;

    renderManager();
    await chooseFirstPerson(user);
    await user.click(screen.getByRole("button", { name: /^Add$/i }));

    await waitFor(() => expect(notifyError).toHaveBeenCalled());
    // The bug: a success toast fired alongside the error.
    expect(toast.success).not.toHaveBeenCalled();
  });
});

describe("ProjectMembersManager — adding a member that succeeds", () => {
  it("confirms success and clears the form", async () => {
    const user = userEvent.setup();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "pm1", orgMemberId: "om1", role: "MEMBER" }),
    }) as unknown as typeof fetch;

    renderManager();
    await chooseFirstPerson(user);
    await user.click(screen.getByRole("button", { name: /^Add$/i }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Member added to project."),
    );
    expect(notifyError).not.toHaveBeenCalled();
  });
});
