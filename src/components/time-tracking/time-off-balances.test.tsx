// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({ usePathname: () => "/acme/time-tracking/time-off" }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

import { TimeOffBalances } from "./time-off-balances";

const ME = { userId: "me", displayName: "Me", isSelf: true, requested: 8, approved: 16, used: 40, allowance: 120, allowanceSource: "org", remaining: 64 };
const OTHER = { userId: "u2", displayName: "Avery", isSelf: false, requested: 0, approved: 0, used: 130, allowance: 120, allowanceSource: "org", remaining: -10 };

let summary: Record<string, unknown>;
const puts: unknown[] = [];

beforeEach(() => {
  puts.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        puts.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ ok: true }));
      }
      if (String(input).includes("/time-off/summary")) return new Response(JSON.stringify(summary));
      return new Response("{}");
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const renderIt = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TimeOffBalances orgId="org1" />
    </QueryClientProvider>,
  );

describe("TimeOffBalances", () => {
  it("a member sees their own balance and no table of other people", async () => {
    summary = { year: 2026, countedKinds: ["VACATION"], defaultAllowance: 120, canManage: false, rows: [ME] };
    renderIt();
    const mine = await screen.findByTestId("my-balance");
    expect(within(mine).getByText("Remaining").nextSibling?.textContent).toBe("64 h");
    expect(within(mine).getByText("Waiting for a decision").nextSibling?.textContent).toBe("8 h");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByLabelText(/Default yearly allowance/)).toBeNull();
  });

  it("someone who may read others gets the table, read-only without manage rights", async () => {
    summary = { year: 2026, countedKinds: ["VACATION"], defaultAllowance: 120, canManage: false, rows: [ME, OTHER] };
    renderIt();
    const table = await screen.findByRole("table");
    const avery = within(table).getByText("Avery").closest("tr")!;
    expect(within(avery).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Avery", "120 h", "0 h", "0 h", "130 h", "-10 h"]);
    expect(screen.queryByLabelText("Allowance for Avery")).toBeNull();
  });

  it("a manager sets one person's allowance for the year shown", async () => {
    summary = { year: 2026, countedKinds: ["VACATION"], defaultAllowance: 120, canManage: true, rows: [ME, OTHER] };
    renderIt();
    const input = await screen.findByLabelText("Allowance for Avery");
    fireEvent.change(input, { target: { value: "160" } });
    fireEvent.blur(input);
    await waitFor(() => expect(puts).toEqual([{ userId: "u2", year: 2026, hours: 160 }]));
  });

  it("no allowance: says so instead of a fake zero", async () => {
    summary = { year: 2026, countedKinds: ["VACATION"], defaultAllowance: null, canManage: false, rows: [{ ...ME, allowance: null, allowanceSource: null, remaining: null }] };
    renderIt();
    expect(await screen.findByText("No allowance set")).toBeTruthy();
  });
});
