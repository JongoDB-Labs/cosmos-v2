// @vitest-environment jsdom
// The org's workflow settings card: only for people who manage workflows, and
// each change PUTs just what changed.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({ usePathname: () => "/alpha/settings/organization", useParams: () => ({ orgSlug: "alpha" }) }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/lib/query/json-fetcher", () => ({ jsonFetch: vi.fn() }));

import { WorkflowSettingsCard } from "./workflow-settings";
import { jsonFetch } from "@/lib/query/json-fetcher";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const SETTINGS = { blockParentWithOpenChildren: true, resolutions: ["Fixed", "Won't do"] };

describe("WorkflowSettingsCard", () => {
  it("is hidden from people who can't manage workflows", async () => {
    vi.mocked(jsonFetch).mockResolvedValue({ ...SETTINGS, canManage: false } as never);
    wrap(<WorkflowSettingsCard orgId="o1" />);
    await waitFor(() => expect(jsonFetch).toHaveBeenCalled());
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("turns the parent guard off", async () => {
    vi.mocked(jsonFetch).mockResolvedValue({ ...SETTINGS, canManage: true } as never);
    wrap(<WorkflowSettingsCard orgId="o1" />);
    const sw = await screen.findByRole("switch", { name: "Block finishing a parent with open sub-items" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(sw);
    await waitFor(() =>
      expect(jsonFetch).toHaveBeenCalledWith("/api/v1/orgs/o1/workflow-settings", {
        method: "PUT",
        body: JSON.stringify({ blockParentWithOpenChildren: false }),
      }),
    );
  });

  it("saves the resolutions list, trimmed and without repeats", async () => {
    vi.mocked(jsonFetch).mockResolvedValue({ ...SETTINGS, canManage: true } as never);
    wrap(<WorkflowSettingsCard orgId="o1" />);
    const input = await screen.findByLabelText("Resolutions");
    expect((input as HTMLInputElement).value).toBe("Fixed, Won't do");
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.change(input, { target: { value: " Fixed , Duplicate, Fixed ," } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(jsonFetch).toHaveBeenCalledWith("/api/v1/orgs/o1/workflow-settings", {
        method: "PUT",
        body: JSON.stringify({ resolutions: ["Fixed", "Duplicate"] }),
      }),
    );
  });
});
