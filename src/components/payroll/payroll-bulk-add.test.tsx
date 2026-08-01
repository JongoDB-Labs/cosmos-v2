// @vitest-environment jsdom
//
// The way out of "26 members, zero employee records".
//
// Supervision, timesheet approval and labor costing all hang off an `Employee`
// row; an org that has never used payroll has none, and the only cure was
// adding people one at a time with a cost rate typed in for each. This prompt
// is the bulk route's user-facing half.
//
// VACUITY WATCH (AGENTS.md): every case here drives a real click and asserts on
// what `jsonFetch` RECEIVES — the request body — not on what was merely
// rendered. Asserting a checkbox looks checked would pass against a component
// that ignored it when building the payload.
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

vi.mock("next/navigation", () => ({ usePathname: () => "/acme/finance/payroll" }));
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
const CARA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const MEMBERS = [
  { userId: ALICE, user: { displayName: "Alice Reyes" } },
  { userId: BOB, user: { displayName: "Bob Nakamura" } },
  { userId: CARA, user: { displayName: "Cara Okafor" } },
];

/** `employeesFor` = the user ids that ALREADY have an employee record. */
function stubApi(employeesFor: string[]) {
  vi.mocked(jsonFetch).mockImplementation(((url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      return Promise.resolve({ created: 0, skipped: 0, createdUserIds: [] });
    }
    if (url.endsWith("/members")) return Promise.resolve(MEMBERS);
    if (url.endsWith("/employees")) {
      return Promise.resolve({
        data: employeesFor.map((userId, i) => ({
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

/** The body the component POSTed to the bulk endpoint. */
function postedUserIds(): string[] {
  const call = vi
    .mocked(jsonFetch)
    .mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/employees/bulk") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
  if (!call) throw new Error("nothing was POSTed to /employees/bulk");
  return JSON.parse(String((call[1] as RequestInit).body)).userIds;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Payroll — bulk-add prompt", () => {
  it("offers every member who has no employee record, with all of them chosen", async () => {
    stubApi([]);
    renderDashboard();

    const button = await screen.findByRole("button", {
      name: "Add 3 employee records",
    });
    await userEvent.click(button);

    await waitFor(() => expect(postedUserIds()).toEqual([ALICE, BOB, CARA]));
  });

  it("offers only the people who are still missing a record", async () => {
    stubApi([ALICE]);
    renderDashboard();

    await userEvent.click(
      await screen.findByRole("button", { name: "Add 2 employee records" }),
    );

    await waitFor(() => expect(postedUserIds()).toEqual([BOB, CARA]));
  });

  it("says plainly that the cost rates arrive UNSET", async () => {
    // The server refuses to invent a rate, so the person clicking has to know
    // the records land at zero and are theirs to price. Dropping this sentence
    // is how time gets costed at nothing without anyone noticing.
    stubApi([]);
    renderDashboard();

    expect(await screen.findByText(/cost rate of \$0\.00/i)).toBeTruthy();
    expect(
      screen.getByText(/before you\s+run payroll/i),
    ).toBeTruthy();
  });

  it("leaves out anyone the admin unticks", async () => {
    stubApi([]);
    renderDashboard();

    await userEvent.click(
      await screen.findByRole("button", { name: "Choose who" }),
    );
    await userEvent.click(screen.getByRole("checkbox", { name: "Bob Nakamura" }));

    // The button count follows the selection, and — the part that matters —
    // so does the request.
    await userEvent.click(
      screen.getByRole("button", { name: "Add 2 employee records" }),
    );

    await waitFor(() => expect(postedUserIds()).toEqual([ALICE, CARA]));
  });

  it("stops excluding people once the batch has gone in", async () => {
    // An untick means "not in THIS batch", not "never". Carrying it over
    // stranded the prompt on a disabled "Add 0 employee records" whose only
    // explanation was hidden behind "Choose who" — found by driving the real
    // screen, not by any mocked test.
    stubApi([]);
    renderDashboard();

    await userEvent.click(
      await screen.findByRole("button", { name: "Choose who" }),
    );
    await userEvent.click(screen.getByRole("checkbox", { name: "Cara Okafor" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Add 2 employee records" }),
    );

    // Everyone still missing a record is offered again — nobody is silently
    // held back from the next batch.
    expect(
      await screen.findByRole("button", { name: "Add 3 employee records" }),
    ).toBeTruthy();
  });

  it("is not shown at all once everyone has a record", async () => {
    stubApi([ALICE, BOB, CARA]);
    renderDashboard();

    // Wait on a NAMED employee row, not on the static "Employees" heading —
    // that heading paints before either query resolves, so asserting after it
    // only proves the prompt is absent while the page is still loading, which
    // it is no matter what the code does. (Caught by mutation testing: removing
    // the render guard entirely left this test green.)
    expect(await screen.findByText("Alice Reyes")).toBeTruthy();
    expect(screen.queryByText(/have no employee record/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Add \d+ employee record/ })).toBeNull();
  });
});
