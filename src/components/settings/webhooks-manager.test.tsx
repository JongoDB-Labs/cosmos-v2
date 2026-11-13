// @vitest-environment jsdom
// The webhooks settings screen against what its routes really send: the
// delivery log is a bare list, a test send answers 200 with the delivery
// whether or not the endpoint took it, and a refused URL comes back as a
// field issue.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  usePathname: () => "/alpha/settings/webhooks",
  useParams: () => ({ orgSlug: "alpha" }),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/lib/query/json-fetcher", async (orig) => ({
  ...(await orig<typeof import("@/lib/query/json-fetcher")>()),
  jsonFetch: vi.fn(),
}));

import { WebhooksManager } from "./webhooks-manager";
import { FetchError, jsonFetch } from "@/lib/query/json-fetcher";
import { notifyError } from "@/lib/errors/notify";

const HOOK = {
  id: "w1", orgId: "o1", url: "https://hooks.example.com/a", events: ["work_item.created"],
  active: true, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
};
const DELIVERY = {
  id: "d1", webhookId: "w1", event: "work_item.created", payload: {}, status: "FAILED",
  statusCode: 500, responseBody: "boom", attempts: 2, lastAttemptAt: "2026-11-02T00:00:00Z",
  createdAt: "2026-11-02T00:00:00Z", eventId: "42", nextAttemptAt: null,
};

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(jsonFetch).mockImplementation(async (url) => {
    if (String(url) === "/api/v1/orgs/o1/webhooks") return [HOOK] as never;
    throw new Error(`unexpected jsonFetch ${String(url)}`);
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("WebhooksManager", () => {
  // First in the file: React warns about a state update during another
  // component's render only once per component pair, per module.
  it("opening a row asks for its log once, after render", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/w1/deliveries") ? json([DELIVERY]) : json({}, 404),
    );
    wrap(<WebhooksManager orgId="o1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Expand row" }));
    await screen.findByText("2 attempts");
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/w1/deliveries"))).toHaveLength(1);
    // React reports a state update made while another component renders.
    expect(errors.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("while rendering a different component"))).toEqual([]);
    errors.mockRestore();
  });

  it("shows the deliveries the route sends (a bare list)", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/w1/deliveries") ? json([DELIVERY]) : json({}, 404),
    );
    wrap(<WebhooksManager orgId="o1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Expand row" }));
    await screen.findByText("2 attempts");
    expect(screen.queryByText("No deliveries yet")).toBeNull();
  });

  it("an empty delivery log says so", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/w1/deliveries") ? json([]) : json({}, 404),
    );
    wrap(<WebhooksManager orgId="o1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Expand row" }));
    await screen.findByText("No deliveries yet");
  });

  it("a test send the endpoint refused reads as failed, with its reason", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/w1/test")) return json({ ...DELIVERY, event: "test", status: "FAILED", statusCode: null, responseBody: "Couldn't resolve hooks.example.com" });
      if (url.endsWith("/w1/deliveries")) return json([]);
      return json({}, 404);
    });
    wrap(<WebhooksManager orgId="o1" />);
    fireEvent.click((await screen.findAllByTitle("Send test"))[0]);
    fireEvent.click(screen.getByRole("button", { name: "Expand row" }));
    await screen.findByText("Test delivery failed: Couldn't resolve hooks.example.com");
    expect(screen.queryByText("Test delivery sent")).toBeNull();
  });

  it("a test send the endpoint took reads as sent", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/w1/test")) return json({ ...DELIVERY, event: "test", status: "SUCCESS", statusCode: 200 });
      if (url.endsWith("/w1/deliveries")) return json([]);
      return json({}, 404);
    });
    wrap(<WebhooksManager orgId="o1" />);
    fireEvent.click((await screen.findAllByTitle("Send test"))[0]);
    fireEvent.click(screen.getByRole("button", { name: "Expand row" }));
    await screen.findByText("Test delivery sent");
  });

  it("a refused URL shows the server's reason under the field", async () => {
    const reason = "Webhook URL must be a public http(s) endpoint (no localhost, private IPs, or file://)";
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (init?.method === "POST") {
        throw new FetchError(400, { error: "Invalid request", issues: [{ code: "custom", path: ["url"], message: reason }] }, "Invalid request");
      }
      return [HOOK] as never;
    });
    wrap(<WebhooksManager orgId="o1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Add Webhook" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByPlaceholderText("https://example.com/webhook"), { target: { value: "http://[::1]/x" } });
    fireEvent.click(within(dialog).getAllByRole("checkbox")[0]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await within(dialog).findByText(reason);
    expect(notifyError).not.toHaveBeenCalled();
  });

  it("any other failure still raises the toast", async () => {
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (init?.method === "POST") throw new FetchError(500, { error: "Internal error" }, "Internal error");
      return [HOOK] as never;
    });
    wrap(<WebhooksManager orgId="o1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Add Webhook" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByPlaceholderText("https://example.com/webhook"), { target: { value: "https://hooks.example.com/b" } });
    fireEvent.click(within(dialog).getAllByRole("checkbox")[0]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(notifyError).toHaveBeenCalled());
  });

  it("a webhook acts for its creator: it names them, or says why it sends nothing", async () => {
    const reason = "The person who created it is no longer a member of this organization. Create it again to resume.";
    vi.mocked(jsonFetch).mockImplementation(async () => [
      { ...HOOK, createdById: "u1", createdBy: { displayName: "Alice" }, pausedReason: null },
      { ...HOOK, id: "w2", url: "https://hooks.example.com/b", createdById: "u2", createdBy: { displayName: "Bob" }, pausedReason: reason },
    ] as never);
    wrap(<WebhooksManager orgId="o1" />);
    await screen.findByText("Sends events from projects Alice can read.");
    await screen.findByText(`Sends nothing. ${reason}`);
    // The paused one doesn't also claim to send.
    expect(screen.queryByText("Sends events from projects Bob can read.")).toBeNull();
  });

  it("a delivery log the viewer may not read says why, instead of loading forever", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/w1/deliveries") ? json({ error: "Forbidden" }, 403) : json({}, 404),
    );
    wrap(<WebhooksManager orgId="o1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Expand row" }));
    await screen.findByText(/needs permission to read work items/);
    expect(screen.queryByText("No deliveries yet")).toBeNull();
  });

  it("a delivery that was never sent says why", async () => {
    const reason = "Not sent: the person who created this webhook can't read this project.";
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/w1/deliveries")
        ? json([{ ...DELIVERY, statusCode: null, attempts: 0, responseBody: reason }, { ...DELIVERY, id: "d2" }])
        : json({}, 404),
    );
    wrap(<WebhooksManager orgId="o1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Expand row" }));
    await screen.findByText(reason);
    // An answer from the endpoint itself (it has a status code) isn't echoed.
    expect(screen.queryByText("boom")).toBeNull();
  });

  it("names each webhook's on/off switch", async () => {
    wrap(<WebhooksManager orgId="o1" />);
    const sw = await screen.findByRole("switch", { name: "Toggle https://hooks.example.com/a" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
  });
});
