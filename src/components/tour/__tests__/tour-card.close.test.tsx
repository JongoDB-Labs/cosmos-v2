// Closing the walkthrough part-way must say where it went and offer the way
// back, at the same step — and must not leave the questions asked in it behind.
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { TourProvider, useTour } from "../tour-provider";
import { TourCard } from "../tour-card";
import type { Tour } from "@/lib/tours/types";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("next/navigation", () => ({ usePathname: () => "/acme", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/providers/permissions-provider", () => ({ usePermissions: () => ({ can: () => true }) }));

const TOUR: Tour = {
  id: "t1",
  name: "Test",
  summary: "",
  released: "2026-01-01",
  steps: [
    { id: "a", title: "Step A", blurb: "", look: "" },
    { id: "b", title: "Step B", blurb: "", look: "" },
    { id: "c", title: "Step C", blurb: "", look: "" },
  ],
};

function Starter() {
  const { start, tour } = useTour();
  return tour ? null : <button onClick={() => start(TOUR, 1)}>start</button>;
}

beforeEach(() => {
  toast.mockReset();
  window.localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 204 }) as unknown as Response));
});

describe("closing the walkthrough", () => {
  it("says where it went and resumes at the same step", () => {
    render(
      <TourProvider>
        <Starter />
        <TourCard orgId="o1" orgSlug="acme" />
      </TourProvider>,
    );
    fireEvent.click(screen.getByText("start"));
    expect(screen.getByText("Step B")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close the walkthrough" }));
    expect(screen.queryByText("Step B")).toBeNull();
    expect(toast).toHaveBeenCalledTimes(1);
    const [title, opts] = toast.mock.calls[0] as [string, { description: string; action: { label: string; onClick: () => void } }];
    expect(title).toBe("Walkthrough closed");
    expect(opts.description).toMatch(/Walkthroughs in the top bar/);
    expect(opts.action.label).toBe("Resume");

    act(() => opts.action.onClick());
    expect(screen.getByText("Step B")).toBeInTheDocument();
  });

  it("offers no resume after finishing it", () => {
    render(
      <TourProvider>
        <Starter />
        <TourCard orgId="o1" orgSlug="acme" />
      </TourProvider>,
    );
    fireEvent.click(screen.getByText("start"));
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("Step C")).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("questions in the card", () => {
  function api() {
    const calls: { method: string; url: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({ method, url: String(url) });
        if (method === "POST" && String(url).endsWith("/conversations"))
          return { ok: true, json: async () => ({ data: { id: "c1" } }) } as unknown as Response;
        if (method === "DELETE") return { ok: true, status: 204 } as unknown as Response;
        const body = `data: ${JSON.stringify({ delta: "the answer" })}\n`;
        return {
          ok: true,
          body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } }),
        } as unknown as Response;
      }),
    );
    return calls;
  }

  it("keep to their step, come back with it, and are deleted when the card closes", async () => {
    const calls = api();
    render(
      <TourProvider>
        <Starter />
        <TourCard orgId="o1" orgSlug="acme" />
      </TourProvider>,
    );
    fireEvent.click(screen.getByText("start"));
    fireEvent.click(screen.getByRole("button", { name: "Ask about this" }));
    const box = screen.getByRole("textbox", { name: "Ask about Step B" });
    fireEvent.change(box, { target: { value: "Why?" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByText("the answer")).toBeInTheDocument();

    // The next step starts with no thread.
    fireEvent.click(screen.getByRole("button", { name: /Next/ }));
    fireEvent.click(screen.getByRole("button", { name: "Ask about this" }));
    expect(screen.queryByText("the answer")).toBeNull();

    // Back again, and step B's thread is still there.
    fireEvent.click(screen.getByRole("button", { name: /Back/ }));
    fireEvent.click(screen.getByRole("button", { name: "Ask about this" }));
    expect(screen.getByText("the answer")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close the walkthrough" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
        "/api/v1/orgs/o1/assistant/conversations/c1",
      ]),
    );
  });
});
