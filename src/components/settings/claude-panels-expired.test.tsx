// @vitest-environment jsdom
//
// A Claude connection whose token expired and could not be renewed used to
// render exactly like a healthy one — a green "Connected" over "Authorization
// valid until <a date in the past>" — while every agent request 401'd. Both
// panels (personal and org) must say so and offer the connect flow instead.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

vi.mock("next/navigation", () => ({ usePathname: () => "/acme/settings/ai" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

const { status } = vi.hoisted(() => ({
  status: { current: {} as Record<string, unknown> },
}));
vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn(() => Promise.resolve(status.current)),
}));

import { ClaudeAccountPanel } from "./claude-account-panel";
import { ClaudeSubscriptionPanel } from "./claude-subscription-panel";

afterEach(cleanup);

function renderWith(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const panels: Array<[string, () => ReactElement, RegExp]> = [
  ["personal (Profile)", () => <ClaudeAccountPanel />, /Connect my Claude subscription/],
  ["org (AI / Model)", () => <ClaudeSubscriptionPanel orgId="org-1" />, /Connect Claude subscription/],
];

describe.each(panels)("%s Claude panel", (_name, panel, connectLabel) => {
  it("shows Expired and the connect flow for a connection that can't be used", async () => {
    status.current = { connected: true, expired: true, expiresAt: "2026-10-18T12:00:00.000Z" };
    renderWith(panel());

    expect(await screen.findByText("Expired")).toBeTruthy();
    expect(screen.getByText(/expired on .*couldn't be renewed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: connectLabel })).toBeTruthy();
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.queryByText(/Authorization valid until/)).toBeNull();
  });

  it("still shows Connected for a healthy connection", async () => {
    status.current = { connected: true, expired: false, expiresAt: "2099-01-01T00:00:00.000Z" };
    renderWith(panel());

    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(screen.getByText(/Authorization valid until/)).toBeTruthy();
    expect(screen.queryByText("Expired")).toBeNull();
  });
});
