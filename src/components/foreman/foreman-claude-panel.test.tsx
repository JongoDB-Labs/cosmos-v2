// @vitest-environment jsdom
//
// Foreman's OWN Claude-subscription connect card — mirrors the mocking idiom
// from foreman-console.test.tsx (mock next/navigation + @/lib/query/json-fetcher,
// wrap in a fresh QueryClientProvider per test) and the org connect card's own
// flow (@/components/settings/claude-subscription-panel): GET status, POST
// initiate (open the returned URL in a new tab, reveal the paste-code field),
// POST exchange with the pasted code, POST disconnect.
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/foreman",
  useParams: () => ({ orgSlug: "acme" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

import { toast } from "sonner";

beforeAll(() => {
  // base-ui (Button/Input) needs these in jsdom — see
  // memory/testing-base-ui-in-jsdom.md (same setup as foreman-console.test.tsx).
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
  Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture || (() => false);
  Element.prototype.setPointerCapture = Element.prototype.setPointerCapture || (() => {});
  Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture || (() => {});
});

interface StatusResponse {
  connected: boolean;
  email?: string;
  expiresAt?: string;
}

const holder: {
  status: StatusResponse;
  calls: { url: string; method?: string; body?: unknown }[];
  initiateUrl: string;
  exchangeResult: { success: boolean; email?: string; error?: string };
} = {
  status: { connected: false },
  calls: [],
  initiateUrl: "https://claude.ai/oauth/authorize?state=abc",
  exchangeResult: { success: true, email: "foreman-bot@acme.test" },
};

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string, opts?: { method?: string; body?: string }) => {
    holder.calls.push({
      url,
      method: opts?.method,
      body: opts?.body ? JSON.parse(opts.body) : undefined,
    });
    if (url.includes("/foreman/claude-subscription/status")) {
      return Promise.resolve(holder.status);
    }
    if (url.includes("/foreman/claude-subscription/initiate")) {
      return Promise.resolve({ url: holder.initiateUrl });
    }
    if (url.includes("/foreman/claude-subscription/exchange")) {
      return Promise.resolve(holder.exchangeResult);
    }
    if (url.includes("/foreman/claude-subscription/disconnect")) {
      return Promise.resolve({ success: true });
    }
    return Promise.reject(new Error(`unexpected jsonFetch url: ${url}`));
  }),
}));

import { ForemanClaudePanel } from "./foreman-claude-panel";

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ForemanClaudePanel orgId="org-1" />
    </QueryClientProvider>,
  );
}

describe("ForemanClaudePanel — not connected", () => {
  const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

  afterEach(() => {
    cleanup();
    holder.calls.length = 0;
    holder.status = { connected: false };
    openSpy.mockClear();
  });

  it('renders a "Connect Claude for Foreman" button', async () => {
    renderPanel();
    expect(
      await screen.findByRole("button", { name: /connect claude for foreman/i }),
    ).toBeInTheDocument();
  });

  it("mentions this connection is separate from the org and personal connections", async () => {
    renderPanel();
    expect(
      await screen.findByText(/separate from the org and personal connections/i),
    ).toBeInTheDocument();
  });

  it("clicking Connect POSTs initiate and opens the returned URL in a new tab", async () => {
    renderPanel();
    const button = await screen.findByRole("button", { name: /connect claude for foreman/i });
    fireEvent.click(button);

    const initiateUrl = "/api/v1/orgs/org-1/foreman/claude-subscription/initiate";
    await waitFor(() => expect(holder.calls.some((c) => c.url === initiateUrl)).toBe(true));
    const call = holder.calls.find((c) => c.url === initiateUrl);
    expect(call?.method).toBe("POST");

    expect(openSpy).toHaveBeenCalledWith(holder.initiateUrl, "_blank", "noopener,noreferrer");

    // Reveals the paste-code step.
    expect(await screen.findByPlaceholderText("Paste code here")).toBeInTheDocument();
  });

  it("pasting a code and finishing POSTs it to exchange", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /connect claude for foreman/i }));

    const codeInput = await screen.findByPlaceholderText("Paste code here");
    fireEvent.change(codeInput, { target: { value: "the-pasted-code" } });
    fireEvent.click(screen.getByRole("button", { name: /finish connecting/i }));

    const exchangeUrl = "/api/v1/orgs/org-1/foreman/claude-subscription/exchange";
    await waitFor(() => expect(holder.calls.some((c) => c.url === exchangeUrl)).toBe(true));
    const call = holder.calls.find((c) => c.url === exchangeUrl);
    expect(call?.method).toBe("POST");
    expect(call?.body).toEqual({ code: "the-pasted-code" });
    expect(toast.success).toHaveBeenCalledWith("Connected as foreman-bot@acme.test.");
  });

  it("shows the server's error and stays on the paste-code step for a bad code", async () => {
    holder.exchangeResult = { success: false, error: "That code has expired." };
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /connect claude for foreman/i }));

    const codeInput = await screen.findByPlaceholderText("Paste code here");
    fireEvent.change(codeInput, { target: { value: "stale-code" } });
    fireEvent.click(screen.getByRole("button", { name: /finish connecting/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("That code has expired."));
    expect(screen.getByPlaceholderText("Paste code here")).toBeInTheDocument();
  });
});

describe("ForemanClaudePanel — connected", () => {
  afterEach(() => {
    cleanup();
    holder.calls.length = 0;
    holder.status = { connected: false };
  });

  it("shows the connected email and a Disconnect control", async () => {
    holder.status = {
      connected: true,
      email: "foreman-bot@acme.test",
      expiresAt: new Date("2026-08-01T00:00:00Z").toISOString(),
    };
    renderPanel();

    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("foreman-bot@acme.test")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /disconnect/i })).toBeInTheDocument();
  });

  it("Disconnect (after confirm) POSTs to the disconnect route", async () => {
    holder.status = { connected: true, email: "foreman-bot@acme.test" };
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /disconnect/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm disconnect/i }));

    const disconnectUrl = "/api/v1/orgs/org-1/foreman/claude-subscription/disconnect";
    await waitFor(() => expect(holder.calls.some((c) => c.url === disconnectUrl)).toBe(true));
    expect(toast.success).toHaveBeenCalledWith("Claude subscription disconnected.");
  });
});
