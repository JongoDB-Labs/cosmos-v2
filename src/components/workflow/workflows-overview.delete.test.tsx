// @vitest-environment jsdom
//
// A workflow nothing follows can be deleted from the list; one in use can't
// (the server refuses it with a 409, so the button isn't offered there).
// Before this, no screen could delete a workflow at all.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({ usePathname: () => "/acme/projects/PRJ/settings/workflows", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
const { jsonFetch } = vi.hoisted(() => ({ jsonFetch: vi.fn() }));
vi.mock("@/lib/query/json-fetcher", async (orig) => ({ ...(await orig<object>()), jsonFetch }));

import { WorkflowsOverview } from "./workflows-overview";

const BASE = "/api/v1/orgs/o1/projects/p1";
const wf = (id: string, name: string, assignedTo: (string | null)[]) => ({
  id, name, description: "", enforcement: "ENFORCE", draft: null, assignedTo,
  published: { version: 1, publishedAt: "2026-10-24T00:00:00.000Z" },
});

beforeEach(() => {
  jsonFetch.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") return { ok: true };
    if (url === `${BASE}/workflows`) {
      return {
        workflows: [wf("w1", "Unused", []), wf("w2", "Default", [null]), wf("w3", "Bugs", ["t1"])],
        assignments: [{ workItemTypeId: null, workflowId: "w2" }, { workItemTypeId: "t1", workflowId: "w3" }],
      };
    }
    return [];
  });
});
afterEach(() => cleanup());

function renderOverview(canManage = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <WorkflowsOverview orgId="o1" orgSlug="acme" projectId="p1" projectKey="PRJ" canManage={canManage} canManageTemplates={false} />
    </QueryClientProvider>,
  );
}

describe("WorkflowsOverview: deleting a workflow", () => {
  it("offers delete only on a workflow nothing follows", async () => {
    renderOverview();
    expect(await screen.findByRole("button", { name: "Delete workflow Unused" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete workflow Default" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete workflow Bugs" })).toBeNull();
  });

  it("offers nothing to someone who can't manage workflows", async () => {
    renderOverview(false);
    await screen.findByText("Unused");
    expect(screen.queryByRole("button", { name: /^Delete workflow/ })).toBeNull();
  });

  it("asks first, and deletes only once confirmed", async () => {
    renderOverview();
    fireEvent.click(await screen.findByRole("button", { name: "Delete workflow Unused" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this workflow?" });
    expect(jsonFetch).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: "DELETE" }));

    fireEvent.click(screen.getByRole("button", { name: "Delete workflow" }));
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledWith(`${BASE}/workflows/w1`, { method: "DELETE" }));
    await waitFor(() => expect(dialog.isConnected).toBe(false));
  });
});
