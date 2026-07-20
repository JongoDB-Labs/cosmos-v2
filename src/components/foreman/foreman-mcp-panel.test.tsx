// @vitest-environment jsdom
//
// Foreman MCP servers manager card — mirrors the mocking idiom from
// foreman-skills-panel.test.tsx (mock next/navigation + sonner +
// @/lib/errors/notify + @/lib/query/json-fetcher, wrap in a fresh
// QueryClientProvider per test): GET the list on mount, POST
// {name, url, headers?, orgScope} to add a server; a non-https url is
// rejected client-side (no POST fires).
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/foreman",
  useParams: () => ({ orgSlug: "acme" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

interface McpServerRow {
  id: string;
  orgId: string | null;
  name: string;
  url: string;
  enabled: boolean;
}

function oneServer(): McpServerRow[] {
  return [
    {
      id: "mcp-1",
      orgId: null,
      name: "shared-docs",
      url: "https://mcp.example.com/rpc",
      enabled: true,
    },
  ];
}

const holder: {
  servers: McpServerRow[];
  calls: { url: string; method?: string; body?: unknown }[];
} = {
  servers: oneServer(),
  calls: [],
};

vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: vi.fn((url: string, opts?: { method?: string; body?: string }) => {
    holder.calls.push({
      url,
      method: opts?.method,
      body: opts?.body ? JSON.parse(opts.body) : undefined,
    });
    if (opts?.method === "POST") {
      return Promise.resolve({ id: "new-server" });
    }
    if (opts?.method === "PATCH" || opts?.method === "DELETE") {
      return Promise.resolve({});
    }
    return Promise.resolve({ servers: holder.servers });
  }),
}));

import { ForemanMcpPanel } from "./foreman-mcp-panel";

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ForemanMcpPanel orgId="org-1" />
    </QueryClientProvider>,
  );
}

describe("ForemanMcpPanel", () => {
  afterEach(() => {
    cleanup();
    holder.calls.length = 0;
    holder.servers = oneServer();
  });

  it("lists a server returned by GET", async () => {
    renderPanel();
    expect(await screen.findByText("shared-docs")).toBeInTheDocument();
    expect(screen.getByText("https://mcp.example.com/rpc")).toBeInTheDocument();
    expect(screen.getByText("Project")).toBeInTheDocument();
  });

  it("submitting the Add form POSTs {name, url, headers, orgScope}", async () => {
    renderPanel();
    await screen.findByText("shared-docs");

    fireEvent.change(screen.getByLabelText("MCP server name"), { target: { value: "My New Server" } });
    fireEvent.change(screen.getByLabelText("MCP server URL"), {
      target: { value: "https://mcp.acme.com/rpc" },
    });
    fireEvent.change(screen.getByLabelText("MCP server headers"), {
      target: { value: '{"Authorization": "Bearer abc123"}' },
    });

    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    const postUrl = "/api/v1/orgs/org-1/foreman/mcp-servers";
    await waitFor(() =>
      expect(holder.calls.some((c) => c.url === postUrl && c.method === "POST")).toBe(true),
    );
    const call = holder.calls.find((c) => c.url === postUrl && c.method === "POST");
    expect(call?.body).toMatchObject({
      name: "My New Server",
      url: "https://mcp.acme.com/rpc",
      headers: { Authorization: "Bearer abc123" },
      orgScope: true,
    });
  });

  it("a non-https url is rejected client-side — no POST fires", async () => {
    renderPanel();
    await screen.findByText("shared-docs");

    fireEvent.change(screen.getByLabelText("MCP server name"), { target: { value: "Local Thing" } });
    fireEvent.change(screen.getByLabelText("MCP server URL"), {
      target: { value: "file:///etc/passwd" },
    });

    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));

    expect(
      await screen.findByText(/only remote http\(s\) mcp servers are allowed/i),
    ).toBeInTheDocument();
    const postUrl = "/api/v1/orgs/org-1/foreman/mcp-servers";
    expect(holder.calls.some((c) => c.url === postUrl && c.method === "POST")).toBe(false);
  });
});
