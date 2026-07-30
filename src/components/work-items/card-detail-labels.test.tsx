// @vitest-environment jsdom
/**
 * Editing an issue must offer the same reach as creating one.
 *
 * The create dialog has always accepted labels, and the work-item PUT has
 * always written them (`setWorkItemLabels` keeps the label catalogue in step).
 * Only the detail sheet had no control — zero references to tags in the whole
 * file — so a label could be set when an issue was filed and never changed
 * again. Reported as "can't see label(s) in the issue details to add/remove/
 * update".
 *
 * These drive the real sheet and assert what it PUTs, so a control that renders
 * but doesn't persist would still fail.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CardDetailSheet } from "./card-detail-sheet";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/issues",
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  useParams: () => ({ projectKey: "FSC" }),
  useSearchParams: () => new URLSearchParams(),
}));

const ITEM = {
  id: "wi-1",
  orgId: "org-1",
  projectId: "p1",
  title: "A ticket",
  description: "",
  columnKey: "todo",
  priority: "MEDIUM",
  ticketNumber: 7,
  tags: ["backend"],
  assignees: [],
  customFields: {},
  createdAt: "",
  updatedAt: "",
} as never;

let puts: { url: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  puts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const json = (b: unknown) =>
        new Response(JSON.stringify(b), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        puts.push({ url: u, body });
        return json({ ...(ITEM as object), ...body });
      }
      if (u.includes("/labels")) {
        return json([{ id: "l1", name: "backend" }, { id: "l2", name: "urgent" }]);
      }
      return json([]);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSheet() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CardDetailSheet
        item={ITEM}
        open
        onOpenChange={() => {}}
        orgId="org-1"
        projectId="p1"
        members={[]}
        intervals={[]}
        columns={[{ key: "todo", name: "To Do" }] as never}
        onUpdate={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe("labels in the issue detail sheet", () => {
  it("shows the labels the issue already has", async () => {
    renderSheet();
    expect(await screen.findByText("backend")).toBeTruthy();
  });

  it("adds a label and PUTs the full tag list", async () => {
    const user = userEvent.setup();
    renderSheet();
    const input = await screen.findByLabelText("Add label");
    await user.type(input, "urgent{Enter}");
    await waitFor(() => expect(puts.length).toBeGreaterThan(0));
    // The whole list, not a delta — `setWorkItemLabels` replaces the set.
    expect(puts.at(-1)!.body.tags).toEqual(["backend", "urgent"]);
  });

  it("removes a label and PUTs the remainder", async () => {
    const user = userEvent.setup();
    renderSheet();
    await user.click(await screen.findByLabelText("Remove label backend"));
    await waitFor(() => expect(puts.length).toBeGreaterThan(0));
    expect(puts.at(-1)!.body.tags).toEqual([]);
  });

  it("ignores a duplicate rather than adding a second chip", async () => {
    const user = userEvent.setup();
    renderSheet();
    const input = await screen.findByLabelText("Add label");
    await user.type(input, "BACKEND{Enter}"); // different case, same label
    await new Promise((r) => setTimeout(r, 50));
    expect(puts).toHaveLength(0);
  });

  it("ignores an empty submission", async () => {
    const user = userEvent.setup();
    renderSheet();
    const input = await screen.findByLabelText("Add label");
    await user.type(input, "   {Enter}");
    await new Promise((r) => setTimeout(r, 50));
    expect(puts).toHaveLength(0);
  });
});
