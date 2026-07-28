// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({ usePathname: () => "/acme/issues/labels" }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/components/providers/permissions-provider", () => ({
  usePermissions: () => ({ can: () => true }),
}));

const jsonFetchMock = vi.fn();
vi.mock("@/lib/query/json-fetcher", () => ({
  jsonFetch: (...args: unknown[]) => jsonFetchMock(...args),
}));

import { LabelsManager } from "@/components/work-items/labels-manager";
import { toast } from "sonner";

const LABELS = [
  { id: "L1", name: "Security", color: null, itemCount: 3 },
  { id: "L2", name: "Unused", color: null, itemCount: 0 },
];

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView || (() => {});
});

afterEach(() => {
  cleanup();
  jsonFetchMock.mockReset();
  vi.mocked(toast.success).mockReset();
});

function setup() {
  jsonFetchMock.mockImplementation((url: string) => {
    if (url.includes("/labels")) return Promise.resolve(LABELS);
    if (url.includes("/projects")) return Promise.resolve([]);
    return Promise.resolve([]);
  });
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <LabelsManager orgId="org" />
    </QueryClientProvider>,
  );
}

describe("LabelsManager", () => {
  it("lists every label with its usage count, including unused ones", async () => {
    setup();
    await waitFor(() => expect(screen.getByText("Security")).toBeTruthy());

    // The zero-use label must be listed — those are exactly the ones an admin
    // opens this screen to clean up.
    expect(screen.getByText("Unused")).toBeTruthy();
    expect(screen.getByText("3 items")).toBeTruthy();
    expect(screen.getByText("0 items")).toBeTruthy();
  });

  it("tells the user when a rename MERGED rather than just renamed", async () => {
    setup();
    await waitFor(() => expect(screen.getByText("Security")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Rename Security" }));
    const input = screen.getByRole("textbox", { name: "Rename Security" });
    fireEvent.change(input, { target: { value: "Unused" } });

    jsonFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === "PATCH") {
        return Promise.resolve({ merged: true, itemsTouched: 3 });
      }
      if (url.includes("/labels")) return Promise.resolve(LABELS);
      return Promise.resolve([]);
    });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));

    // Silently swallowing a merge would look like a label vanished.
    await waitFor(() =>
      expect(vi.mocked(toast.success).mock.calls.at(-1)?.[0]).toMatch(
        /Merged into “Unused” · 3 items moved/,
      ),
    );
  });

  it("says how many items a delete will touch before doing it", async () => {
    setup();
    await waitFor(() => expect(screen.getByText("Security")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Delete Security" }));

    await waitFor(() =>
      expect(screen.getByText(/removes it from 3 work items/)).toBeTruthy(),
    );
    // Reassurance that matters: a delete here is org-wide, and users need to
    // know their other labels survive.
    expect(screen.getByText(/keep their other labels/)).toBeTruthy();
  });

  it("does not delete until the confirmation is accepted", async () => {
    setup();
    await waitFor(() => expect(screen.getByText("Security")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Delete Security" }));
    await waitFor(() => expect(screen.getByText(/removes it from 3 work items/)).toBeTruthy());

    expect(
      jsonFetchMock.mock.calls.some((c) => (c[1] as { method?: string })?.method === "DELETE"),
      "opening the dialog must not itself delete anything",
    ).toBe(false);
  });
});
