// @vitest-environment jsdom
//
// The Supervisor column's button, and what a screen reader is told about it.
//
// A row's supervisors are fetched only once the row is opened. The button
// used to show "— none —" until then, and its name carried that label, so a
// person who HAS supervisors was announced as having none. Until the value is
// known the button now shows, and says, what it does; once loaded, who.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

vi.mock("next/navigation", () => ({ usePathname: () => "/acme/accounting/payroll" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/lib/query/json-fetcher", async (orig) => {
  const actual = await orig<typeof import("@/lib/query/json-fetcher")>();
  return { ...actual, jsonFetch: vi.fn() };
});

import { PayrollDashboard } from "./payroll-dashboard";
import { jsonFetch } from "@/lib/query/json-fetcher";

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const MEMBERS = [
  { userId: ALICE, user: { displayName: "Alice Reyes" } },
  { userId: BOB, user: { displayName: "Bob Nakamura" } },
];

/** Alice (e0) and Bob (e1) are employees; `aliceSupervisors` are Alice's. */
function stubApi(aliceSupervisors: string[]) {
  vi.mocked(jsonFetch).mockImplementation(((url: string) => {
    if (url.endsWith("/members")) return Promise.resolve(MEMBERS);
    if (url.endsWith("/employees")) {
      return Promise.resolve({
        data: [ALICE, BOB].map((userId, i) => ({
          id: `e${i}`,
          userId,
          employmentType: "HOURLY",
          costRate: "0",
          laborCategory: null,
          status: "active",
          managerId: null,
        })),
      });
    }
    if (url.endsWith("/employees/e0/supervisors")) {
      return Promise.resolve({
        supervisorIds: aliceSupervisors,
        candidates: [{ employeeId: "e1", userId: BOB, displayName: "Bob Nakamura", canApprove: true }],
        approversMissingEmployeeRecord: [],
        requestedIds: [],
      });
    }
    if (url.endsWith("/pay-runs")) return Promise.resolve({ data: [] });
    return Promise.resolve([]);
  }) as never);
}

function renderDashboard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PayrollDashboard orgId="11111111-1111-4111-8111-111111111111" />
    </QueryClientProvider>,
  );
}

const aliceButton = (opts: { hidden?: boolean } = {}) =>
  screen.findByRole("button", { name: /^Edit supervisors for Alice Reyes/, ...opts });

const supervisorFetches = () =>
  vi.mocked(jsonFetch).mock.calls.filter(([url]) => String(url).endsWith("/supervisors")).length;

afterEach(() => {
  cleanup();
  vi.mocked(jsonFetch).mockReset();
});

describe("the Supervisor button's name", () => {
  it("claims no value before the supervisors load", async () => {
    stubApi(["e1"]);
    renderDashboard();
    const button = await aliceButton();
    // Positive control: nothing has asked who Alice's supervisors are, so the
    // page cannot know. She has one; saying "none" would be false.
    expect(supervisorFetches()).toBe(0);
    expect(button).toHaveAccessibleName("Edit supervisors for Alice Reyes");
    expect(button).toHaveTextContent(/^Edit$/);
    expect(screen.queryByText(/none/)).toBeNull();
  });

  it("says who, once they have loaded", async () => {
    stubApi(["e1"]);
    renderDashboard();
    await userEvent.click(await aliceButton());
    await waitFor(() => expect(supervisorFetches()).toBe(1));
    // The open dialog hides the page behind it from the accessibility tree.
    await waitFor(async () =>
      expect(await aliceButton({ hidden: true })).toHaveAccessibleName(
        "Edit supervisors for Alice Reyes: Bob Nakamura",
      ),
    );
    expect(await aliceButton({ hidden: true })).toHaveTextContent(/^Bob Nakamura$/);
  });

  it("says none only when there are none", async () => {
    stubApi([]);
    renderDashboard();
    await userEvent.click(await aliceButton());
    await waitFor(async () =>
      expect(await aliceButton({ hidden: true })).toHaveAccessibleName(
        "Edit supervisors for Alice Reyes: — none —",
      ),
    );
  });
});
