// @vitest-environment jsdom
// What a viewer who is not the instance operator can and cannot do in the
// feedback automation form, and that the operator is not limited. The server
// refuses a widen either way; the form disables those controls up front and
// says why, and must never stop anyone turning things off.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({ usePathname: () => "/acme/settings/feedback-automation" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

const A = "a-id";
const B = "b-id";
type Cfg = Record<string, unknown>;
const h = vi.hoisted(() => ({ cfg: null as unknown, puts: [] as Cfg[] }));
vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((_url: string, opts?: { method?: string; body?: string }) => {
    if (opts?.method === "PUT") {
      h.puts.push(JSON.parse(opts.body ?? "{}"));
      return Promise.resolve({});
    }
    return Promise.resolve(h.cfg);
  }),
}));
import { FeedbackAutomationForm } from "./feedback-automation-form";

const deliveryOn = (workers = 2) => ({ enabled: true, projectIds: [A], notify: { parked: true, shipped: true }, workers });
const config = (over: Cfg) => ({
  autoRemediation: { enabled: false, projectIds: [], defaultProjectId: null },
  autonomousDelivery: { enabled: false, projectIds: [], notify: { parked: true, shipped: true }, workers: 2 },
  projects: [
    { id: A, key: "AAA", name: "Alpha" },
    { id: B, key: "BBB", name: "Bravo" },
  ],
  aiConnected: true,
  aiProvider: "claude-oauth",
  claudeSubscription: { connected: true },
  ...over,
});
const renderForm = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FeedbackAutomationForm orgId="org-1" />
    </QueryClientProvider>,
  );
const toggle = (name: string) => screen.findByRole("switch", { name });
const project = async (group: string, key: RegExp) =>
  within(await screen.findByRole("group", { name: group })).getByRole("checkbox", { name: key });
const workersButton = async (n: number) =>
  within(await screen.findByRole("group", { name: "Parallel builds" })).getByRole("button", { name: String(n) });

afterEach(() => {
  cleanup();
  h.puts.length = 0;
});

describe("a viewer who is not the instance operator", () => {
  it("can switch delivery off, even with no AI provider connected", async () => {
    h.cfg = config({ viewerIsOperator: false, aiConnected: false, autonomousDelivery: deliveryOn() });
    renderForm();
    const delivery = await toggle("Enable autonomous delivery");
    expect(delivery).not.toBeDisabled();
    fireEvent.click(delivery);
    await waitFor(() => expect(h.puts.length).toBe(1));
    expect((h.puts[0].autonomousDelivery as { enabled: boolean }).enabled).toBe(false);
  });

  it("with everything off, sees both switches and every project disabled, pointing at the reason", async () => {
    h.cfg = config({ viewerIsOperator: false });
    renderForm();
    expect(await toggle("Enable autonomous delivery")).toBeDisabled();
    expect(await toggle("Enable auto-triage")).toBeDisabled();
    expect(await project("Projects for autonomous delivery", /AAA/)).toBeDisabled();
    expect(await project("Projects to receive triaged feedback", /AAA/)).toBeDisabled();
    const noteId = (await toggle("Enable autonomous delivery")).getAttribute("aria-describedby");
    expect(noteId && document.getElementById(noteId)?.textContent).toBe(
      "Only the instance operator can turn on automated delivery or add build workers.",
    );
  });

  it("can uncheck a saved project but not add another", async () => {
    h.cfg = config({ viewerIsOperator: false, autonomousDelivery: deliveryOn() });
    renderForm();
    expect(await project("Projects for autonomous delivery", /AAA/)).not.toBeDisabled();
    expect(await project("Projects for autonomous delivery", /BBB/)).toBeDisabled();
  });

  it("can lower parallel builds but not raise them past what is saved", async () => {
    h.cfg = config({ viewerIsOperator: false, autonomousDelivery: deliveryOn(2) });
    renderForm();
    expect(await workersButton(3)).toBeDisabled();
    expect(await workersButton(2)).not.toBeDisabled();
    const one = await workersButton(1);
    expect(one).not.toBeDisabled();
    fireEvent.click(one);
    await waitFor(() => expect(h.puts.length).toBe(1));
    expect((h.puts[0].autonomousDelivery as { workers: number }).workers).toBe(1);
  });
});

describe("the instance operator", () => {
  it("has nothing disabled and sees no note", async () => {
    h.cfg = config({ viewerIsOperator: true, autonomousDelivery: deliveryOn(1) });
    renderForm();
    expect(await toggle("Enable autonomous delivery")).not.toBeDisabled();
    expect(await toggle("Enable auto-triage")).not.toBeDisabled();
    expect(await project("Projects for autonomous delivery", /BBB/)).not.toBeDisabled();
    expect(await workersButton(3)).not.toBeDisabled();
    expect(screen.queryByText(/Only the instance operator/)).toBeNull();
  });
});
