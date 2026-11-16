// @vitest-environment jsdom
//
// Each saved report's row ends in two icon-only buttons, Edit and Delete. They
// had no name at all: a screen reader said "button, button" on every row, and
// nothing told them apart or said which report they acted on (axe
// `button-name`, critical). The a11y e2e gate scans /analytics/reports, but the
// CI seed saves no reports, so the table never rendered there and the rule
// never saw these buttons. Named after the report, so each is unique on the
// page.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/analytics/reports",
}));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch: vi.fn() }));

import { ReportsManager } from "./reports-manager";
import { jsonFetch } from "@/lib/query/json-fetcher";

const report = (id: string, name: string) => ({
  id,
  orgId: "o1",
  createdById: "u1",
  name,
  type: "burndown",
  config: {},
  schedule: null,
  lastRunAt: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
});

function renderManager() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ReportsManager orgId="o1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(jsonFetch).mockResolvedValue([report("r1", "Weekly burndown"), report("r2", "Quarter velocity")]);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ReportsManager — a report's row actions are named after the report", () => {
  it("names Edit and Delete for the report they act on", async () => {
    renderManager();
    // Positive control: the rows rendered, so the buttons below are really there.
    await screen.findByText("Weekly burndown");
    expect(screen.getByText("Quarter velocity")).toBeInTheDocument();

    for (const name of ["Weekly burndown", "Quarter velocity"]) {
      expect(screen.getByRole("button", { name: `Edit ${name}` })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: `Delete ${name}` })).toBeInTheDocument();
    }
  });

  it("leaves no button in the table without a name", async () => {
    renderManager();
    await screen.findByText("Weekly burndown");
    const table = screen.getByRole("table");
    const buttons = Array.from(table.querySelectorAll("button"));
    // Positive control: two per row.
    expect(buttons).toHaveLength(4);
    const unnamed = buttons.filter(
      (b) => !screen.queryAllByRole("button", { name: /\S/ }).includes(b),
    );
    expect(unnamed).toHaveLength(0);
  });

  it("the named Edit button opens that report's editor", async () => {
    renderManager();
    await screen.findByText("Weekly burndown");
    fireEvent.click(screen.getByRole("button", { name: "Edit Quarter velocity" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Report" });
    expect(dialog.querySelector("input")).toHaveValue("Quarter velocity");
  });
});
