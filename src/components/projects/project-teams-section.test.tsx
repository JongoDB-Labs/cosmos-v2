// @vitest-environment jsdom
//
// The Teams screen for the API #519 shipped. #519 deliberately left this out;
// without it a team could only be created by calling the API by hand.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
for (const m of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture"] as const) {
  if (!Element.prototype[m]) {
    // @ts-expect-error — jsdom pointer-capture stubs
    Element.prototype[m] = () => {};
  }
}

vi.mock("next/navigation", () => ({ usePathname: () => "/acme/projects/APL/members" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/lib/query/json-fetcher", async (orig) => {
  const actual = await orig<typeof import("@/lib/query/json-fetcher")>();
  return { ...actual, jsonFetch: vi.fn() };
});

import { ProjectTeamsSection } from "./project-teams-section";
import { jsonFetch } from "@/lib/query/json-fetcher";
import { notifyError } from "@/lib/errors/notify";

const TEAMS = [
  {
    id: "t1",
    name: "Alpha",
    key: null,
    members: [{ id: "tm1", projectMemberId: "pm1", isLead: true, displayName: "Alice" }],
  },
];
const MEMBERS = [
  { id: "pm1", userId: "u1", displayName: "Alice", isBot: false, teamIds: ["t1"] },
  { id: "pm2", userId: "u2", displayName: "Bob", isBot: false, teamIds: [] },
  // A bot on the project must never be offered as someone to staff onto a team.
  { id: "pm3", userId: "u3", displayName: "Foreman", isBot: true, teamIds: [] },
];

function renderSection(canManage = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProjectTeamsSection orgId="o1" projectId="p1" canManage={canManage} />
    </QueryClientProvider>,
  );
}

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  vi.clearAllMocks();
});

function stubReads() {
  vi.mocked(jsonFetch).mockImplementation(((url: string) =>
    url.endsWith("/teams") ? Promise.resolve(TEAMS) : Promise.resolve(MEMBERS)) as never);
}

describe("ProjectTeamsSection", () => {
  it("lists teams with their members and marks the lead", async () => {
    stubReads();
    renderSection();
    expect(await screen.findByText("Alpha")).toBeTruthy();
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByLabelText("Team lead")).toBeTruthy();
  });

  it("creates a team", async () => {
    const user = userEvent.setup();
    stubReads();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    renderSection();
    await user.type(await screen.findByLabelText("New team name"), "Bravo");
    await user.click(screen.getByRole("button", { name: /Create team/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls.find(([, i]) => i?.method === "POST")!;
    expect(url).toBe("/api/v1/orgs/o1/projects/p1/teams");
    expect(JSON.parse(init.body)).toEqual({ name: "Bravo" });
  });

  it("does not claim success when creating a team fails", async () => {
    // Same silent-failure shape that broke the Members section (#504): a caller
    // that cannot observe failure eventually announces success on one.
    const user = userEvent.setup();
    stubReads();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: "A team with that name already exists in this project." }),
    }) as unknown as typeof fetch;

    renderSection();
    await user.type(await screen.findByLabelText("New team name"), "Alpha");
    await user.click(screen.getByRole("button", { name: /Create team/i }));

    await waitFor(() => expect(notifyError).toHaveBeenCalled());
    const { toast } = await import("sonner");
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("offers only unassigned humans when adding to a team", async () => {
    const user = userEvent.setup();
    stubReads();
    renderSection();

    await user.click(await screen.findByRole("button", { name: /Add member/i }));
    const picker = await screen.findByLabelText("Add someone to Alpha");
    await user.click(picker);

    // Bob is on no team; Alice is already on Alpha; Foreman is a bot.
    expect(await screen.findByText("Bob")).toBeTruthy();
    expect(screen.queryByText("Foreman")).toBeNull();
  });

  it("hides every editing affordance from someone who cannot manage", async () => {
    stubReads();
    renderSection(false);
    await screen.findByText("Alpha");
    expect(screen.queryByLabelText("New team name")).toBeNull();
    expect(screen.queryByRole("button", { name: /Add member/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete team/i })).toBeNull();
  });
});
