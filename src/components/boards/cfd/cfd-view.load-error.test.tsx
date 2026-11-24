// @vitest-environment jsdom
// A CFD board whose first load fails shows LoadError with "Try again", and
// "Try again" loads it again.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/projects/FSC/boards/b1",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

// This board reads with bare `fetch` + `res.json()`: no `{ data }` wrapper.
const server = { items: 500 };
vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string) => {
    if (String(url).endsWith("/work-items")) {
      return server.items === 200
        ? new Response("[]", { status: 200 })
        : new Response(JSON.stringify({ error: "Simulated outage" }), { status: server.items });
    }
    return new Response(
      JSON.stringify({ id: "b1", name: "CFD", type: "CFD", config: {}, columns: [] }),
      { status: 200 },
    );
  }),
);

import { CfdView } from "./cfd-view";

afterEach(cleanup);

describe("CFD first-load failure", () => {
  it("is a LoadError, and Try again recovers", async () => {
    render(<CfdView orgId="o1" projectId="p1" projectKey="FSC" boardId="b1" />);
    const retry = await screen.findByRole("button", { name: "Try again" }, { timeout: 3000 });
    expect(screen.getByText("Simulated outage")).toBeTruthy();

    server.items = 200;
    fireEvent.click(retry);
    expect(await screen.findByText("Cumulative Flow Diagram", {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});
