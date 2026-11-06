// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({ usePathname: () => "/acme/accounting/invoices" }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

import { AddReimbursables } from "./add-reimbursables";

const URL = "/api/v1/orgs/o/invoices/i1/reimbursables";
let payload: unknown;
const posts: unknown[] = [];

beforeEach(() => {
  posts.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push({ url: String(input), body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ data: { added: 1 } }));
      }
      if (String(input) === URL) return new Response(JSON.stringify({ data: payload }));
      return new Response("{}");
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrap = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AddReimbursables orgId="o" invoiceId="i1" />
    </QueryClientProvider>,
  );

const B = { source: "bill", id: "b1", label: "A consultant — R-1", date: "2026-10-01", cost: 1000, markup: { pct: 15, source: "org" }, markupAmount: 150, total: 1150 };
const E = { source: "expense", id: "e1", label: "A print shop — Drawings", date: "2026-10-02", cost: 10.05, markup: { pct: 12.5, source: "project" }, markupAmount: 1.26, total: 11.31 };

describe("AddReimbursables", () => {
  it("renders nothing when there is nothing to add", async () => {
    payload = { items: [], lines: "one" };
    const { container } = wrap();
    await new Promise((r) => setTimeout(r, 20));
    expect(container.textContent).toBe("");
  });

  it("lists each cost at cost plus markup, all picked, with the picked total", async () => {
    payload = { items: [B, E], lines: "two" };
    wrap();
    expect(await screen.findByText("A consultant — R-1")).toBeTruthy();
    expect(screen.getByText("$1,000.00 + 15%")).toBeTruthy();
    expect(screen.getByText("$11.31")).toBeTruthy();
    expect(screen.getByText(/as two lines each/)).toBeTruthy();
    expect(screen.getByTestId("reimbursables-picked-total").textContent).toBe("$1,161.31");
    expect(screen.getByRole("button", { name: "Add 2 to invoice" })).toBeTruthy();
  });

  it("adds only the costs left picked", async () => {
    payload = { items: [B, E], lines: "one" };
    wrap();
    fireEvent.click(await screen.findByLabelText("Add A consultant — R-1"));
    expect(screen.getByTestId("reimbursables-picked-total").textContent).toBe("$11.31");
    fireEvent.click(screen.getByRole("button", { name: "Add 1 to invoice" }));
    await waitFor(() => expect(posts).toEqual([{ url: URL, body: { billIds: [], expenseIds: ["e1"] } }]));
  });

  it("can't add nothing", async () => {
    payload = { items: [B], lines: "one" };
    wrap();
    fireEvent.click(await screen.findByLabelText("Add A consultant — R-1"));
    expect((screen.getByRole("button", { name: "Add 0 to invoice" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
