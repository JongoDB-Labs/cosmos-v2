// @vitest-environment jsdom
// Reproduces the reported bug: unchecking an autonomous-delivery project, then
// navigating away and back, must NOT re-check it. The save persists server-side,
// but the form used raw jsonFetch (no cache invalidation), so within the 30s
// React Query staleTime a remount re-seeded from the stale pre-edit cache and the
// checkbox reverted. The fix writes the saved config back into the cache.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({ usePathname: () => "/defcon-new/settings/feedback-automation" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

const COSMOS = "c-id";
const PI = "pi-id";
const VITL = "vitl-id";
const initial = {
  autoRemediation: { enabled: true, projectIds: [COSMOS], defaultProjectId: COSMOS },
  autonomousDelivery: { enabled: true, projectIds: [PI, VITL, COSMOS], notify: { parked: true, shipped: true } },
  projects: [
    { id: COSMOS, key: "COSMOS", name: "Cosmos" },
    { id: PI, key: "PI000", name: "PI" },
    { id: VITL, key: "VITL", name: "BMA" },
  ],
  aiConnected: true,
  aiProvider: "claude-oauth",
  claudeSubscription: { connected: true },
};
const putBodies: { autonomousDelivery: { projectIds: string[] } }[] = [];
vi.mock("@/lib/query/json-fetcher", () => ({
  // GET always returns the ORIGINAL (stale) config — so if the fix's cache write
  // were missing, a remount would re-seed PI000 as checked. The fix makes the
  // remount read the SAVED cache instead, never hitting this GET again.
  jsonFetch: vi.fn((_url: string, opts?: { method?: string; body?: string }) => {
    if (opts?.method === "PUT") {
      putBodies.push(JSON.parse(opts.body ?? "{}"));
      return Promise.resolve({});
    }
    return Promise.resolve(initial);
  }),
}));

 
import { FeedbackAutomationForm } from "./feedback-automation-form";

const renderForm = (qc: QueryClient) =>
  render(
    <QueryClientProvider client={qc}>
      <FeedbackAutomationForm orgId="org-1" />
    </QueryClientProvider>,
  );

const deliveryPi = async () => {
  const group = await screen.findByRole("group", { name: "Projects for autonomous delivery" });
  return within(group).getByRole("checkbox", { name: /PI000/ });
};

describe("FeedbackAutomationForm — delivery checkbox persists across navigation", () => {
  afterEach(() => {
    cleanup();
    putBodies.length = 0;
  });

  it("stays unchecked after unchecking + navigating back (cache reflects the save)", async () => {
    // Same 30s staleTime the app's QueryClient uses — this is what made the stale
    // cache serve on remount instead of refetching.
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false } } });

    const first = renderForm(qc);
    const pi = await deliveryPi();
    expect(pi).toBeChecked();

    fireEvent.click(pi); // uncheck PI000
    await waitFor(() => expect(putBodies.length).toBeGreaterThan(0));
    expect(putBodies.at(-1)?.autonomousDelivery.projectIds).not.toContain(PI);
    await waitFor(() => expect(pi).not.toBeChecked());

    // "Navigate away and back": unmount + remount with the SAME QueryClient.
    first.unmount();
    renderForm(qc);
    const piAgain = await deliveryPi();
    expect(piAgain).not.toBeChecked();
  });
});
