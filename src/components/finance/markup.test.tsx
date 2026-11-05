// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({ usePathname: () => "/acme/accounting/bills" }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { MarkupCell, parseMarkupInput } from "./markup-cell";
import { FinanceSettingsCard } from "./finance-settings-card";
import { ProjectFeeTerms } from "./project-fee-terms";

let settings: Record<string, unknown>;
let terms: Record<string, unknown>;
const writes: { url: string; method: string; body: unknown }[] = [];

beforeEach(() => {
  writes.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method && init.method !== "GET") {
        writes.push({ url: String(input), method: init.method, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ data: {} }));
      }
      if (String(input).endsWith("/finance/settings")) return new Response(JSON.stringify({ data: settings }));
      if (String(input).endsWith("/fee-terms")) return new Response(JSON.stringify({ data: terms }));
      return new Response("{}");
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrap = (ui: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

const bill = (over: Record<string, unknown> = {}) => ({
  id: "b1",
  reference: "INV-7",
  markupPct: null,
  markup: { pct: 15, source: "org" as const },
  ...over,
});

describe("parseMarkupInput", () => {
  it("reads empty as inherit, a percent in range as itself, anything else as invalid", () => {
    expect(parseMarkupInput("  ")).toBeNull();
    expect(parseMarkupInput("12.5")).toBe(12.5);
    expect(parseMarkupInput("0")).toBe(0);
    expect(parseMarkupInput("1000")).toBe(1000);
    expect(parseMarkupInput("-1")).toBeUndefined();
    expect(parseMarkupInput("1000.5")).toBeUndefined();
    expect(parseMarkupInput("abc")).toBeUndefined();
  });
});

describe("MarkupCell", () => {
  it("shows the percent and where an inherited one comes from", () => {
    wrap(<MarkupCell orgId="o" bill={bill()} canManage={false} />);
    expect(screen.getByText("15%")).toBeTruthy();
    expect(screen.getByText("(org default)")).toBeTruthy();
    cleanup();
    wrap(<MarkupCell orgId="o" bill={bill({ markupPct: 20, markup: { pct: 20, source: "bill" } })} canManage={false} />);
    expect(screen.getByText("20%")).toBeTruthy();
    expect(screen.queryByText(/\(/)).toBeNull();
  });

  it("shows a dash for a bill on no project", () => {
    wrap(<MarkupCell orgId="o" bill={bill({ markup: null })} canManage />);
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is read-only without finance-manage", () => {
    wrap(<MarkupCell orgId="o" bill={bill()} canManage={false} />);
    expect(screen.queryByRole("button", { name: "Change markup for INV-7" })).toBeNull();
  });

  it("sets the bill's own percent, and clearing it goes back to inheriting", async () => {
    wrap(<MarkupCell orgId="o" bill={bill({ markupPct: 20, markup: { pct: 20, source: "bill" } })} canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Change markup for INV-7" }));
    const input = screen.getByLabelText("Markup for INV-7") as HTMLInputElement;
    expect(input.value).toBe("20");
    fireEvent.change(input, { target: { value: "25" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(writes).toEqual([{ url: "/api/v1/orgs/o/bills/b1", method: "PATCH", body: { markupPct: 25 } }]));

    cleanup();
    writes.length = 0;
    wrap(<MarkupCell orgId="o" bill={bill({ markupPct: 20, markup: { pct: 20, source: "bill" } })} canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Change markup for INV-7" }));
    const again = screen.getByLabelText("Markup for INV-7");
    fireEvent.change(again, { target: { value: "" } });
    fireEvent.blur(again);
    await waitFor(() => expect(writes).toEqual([{ url: "/api/v1/orgs/o/bills/b1", method: "PATCH", body: { markupPct: null } }]));
  });

  it("writes nothing for an unchanged or invalid value", async () => {
    wrap(<MarkupCell orgId="o" bill={bill()} canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Change markup for INV-7" }));
    fireEvent.blur(screen.getByLabelText("Markup for INV-7")); // "" = still inheriting
    fireEvent.click(screen.getByRole("button", { name: "Change markup for INV-7" }));
    const input = screen.getByLabelText("Markup for INV-7");
    fireEvent.change(input, { target: { value: "-3" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await new Promise((r) => setTimeout(r, 20));
    expect(writes).toEqual([]);
  });
});

describe("FinanceSettingsCard", () => {
  it("is read-only without finance-manage", async () => {
    settings = { reimbursableMarkupPct: 15, reimbursableLines: "two", canManage: false };
    wrap(<FinanceSettingsCard orgId="o" />);
    const pct = (await screen.findByLabelText("Default markup (%)")) as HTMLInputElement;
    expect(pct.value).toBe("15");
    expect(pct.disabled).toBe(true);
    expect((screen.getByLabelText("On the invoice") as HTMLSelectElement).value).toBe("two");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("saves the markup and the line preference together", async () => {
    settings = { reimbursableMarkupPct: 0, reimbursableLines: "one", canManage: true };
    wrap(<FinanceSettingsCard orgId="o" />);
    const pct = await screen.findByLabelText("Default markup (%)");
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(pct, { target: { value: "12.5" } });
    fireEvent.change(screen.getByLabelText("On the invoice"), { target: { value: "two" } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(writes).toEqual([
        { url: "/api/v1/orgs/o/finance/settings", method: "PUT", body: { reimbursableMarkupPct: 12.5, reimbursableLines: "two" } },
      ]),
    );
  });

  it("won't save an out-of-range percent", async () => {
    settings = { reimbursableMarkupPct: 0, reimbursableLines: "one", canManage: true };
    wrap(<FinanceSettingsCard orgId="o" />);
    fireEvent.change(await screen.findByLabelText("Default markup (%)"), { target: { value: "1001" } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ProjectFeeTerms", () => {
  const URL = "/api/v1/orgs/o/projects/p1/fee-terms";

  it("shows the org's default it falls back to, read-only without finance-manage", async () => {
    terms = { markupPct: null, effectiveMarkup: { pct: 15, source: "org" }, canManage: false };
    wrap(<ProjectFeeTerms orgId="o" projectId="p1" />);
    const input = (await screen.findByLabelText("Markup on reimbursable costs (%)")) as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.disabled).toBe(true);
    expect(screen.getByText(/currently 15%/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("sets the project's own markup, and clearing it goes back to the org's", async () => {
    terms = { markupPct: 10, effectiveMarkup: { pct: 10, source: "project" }, canManage: true };
    wrap(<ProjectFeeTerms orgId="o" projectId="p1" />);
    const input = (await screen.findByLabelText("Markup on reimbursable costs (%)")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("10"));
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.click(save);
    await waitFor(() => expect(writes).toEqual([{ url: URL, method: "PUT", body: { markupPct: 12 } }]));
    writes.length = 0;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(save);
    await waitFor(() => expect(writes).toEqual([{ url: URL, method: "PUT", body: { markupPct: null } }]));
  });
});
