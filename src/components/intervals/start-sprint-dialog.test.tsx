// @vitest-environment jsdom
// COSMOS-137 — starting a sprint must launch a planning flow (per-member
// capacity + goal + committed-vs-capacity) BEFORE the sprint activates, rather
// than flipping straight to ACTIVE. This locks that the dialog seeds each
// member's capacity from the suggestion/default, sums a live team total, flags
// over-commitment, and on confirm saves capacity then activates.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// --- base-ui needs these in jsdom (see memory: testing-base-ui-in-jsdom) ---
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

vi.mock("@/components/chat/mention-typeahead", () => ({
  useOrgMembers: vi.fn(),
}));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

import { StartSprintDialog } from "./start-sprint-dialog";
import { useOrgMembers } from "@/components/chat/mention-typeahead";

const MEMBERS = [
  { id: "u1", displayName: "Alice", email: "a@x.io", avatarUrl: null },
  { id: "u2", displayName: "Bob", email: "b@x.io", avatarUrl: null },
];

const PLANNING = {
  unit: "points" as const,
  goal: "",
  committed: { total: 20, itemCount: 3 },
  current: {} as Record<string, number>,
  suggestions: { u1: 10 } as Record<string, number>,
  defaultCapacity: 8,
};

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

/** Route fetch by URL; record every call so we can assert what was sent. */
function installFetch() {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    void init; // 2-arg signature so mock.calls[n][1] carries RequestInit (see bodyOf)
    const u = String(url);
    if (u.endsWith("/planning")) return jsonResponse(PLANNING);
    if (u.endsWith("/capacity")) return jsonResponse([]);
    return jsonResponse({}); // basePath PUT → activate
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function bodyOf(fetchMock: ReturnType<typeof installFetch>, suffixTest: (u: string) => boolean) {
  const call = fetchMock.mock.calls.find(([url]) => suffixTest(String(url)));
  const init = call?.[1] as RequestInit | undefined;
  return init?.body ? JSON.parse(init.body as string) : null;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("StartSprintDialog", () => {
  it("seeds capacity from suggestion/default and flags over-commitment", async () => {
    vi.mocked(useOrgMembers).mockReturnValue({ data: MEMBERS } as ReturnType<
      typeof useOrgMembers
    >);
    installFetch();

    render(
      <StartSprintDialog
        orgId="o1"
        projectId="p1"
        interval={{ id: "c1", name: "Sprint 5", goal: null }}
        onClose={() => {}}
        onStarted={() => {}}
      />,
    );

    // Alice defaults to her recent-velocity suggestion (10); Bob to the constant (8).
    const alice = await screen.findByLabelText("Capacity (pts) for Alice");
    expect((alice as HTMLInputElement).value).toBe("10");
    const bob = screen.getByLabelText("Capacity (pts) for Bob");
    expect((bob as HTMLInputElement).value).toBe("8");

    // Team capacity = 18, committed = 20 → over capacity by 2.
    expect(screen.getByText("18 pts")).toBeTruthy();
    expect(screen.getByText(/Over capacity by 2 pts/)).toBeTruthy();
  });

  it("saves per-member effective capacity, then activates the sprint", async () => {
    vi.mocked(useOrgMembers).mockReturnValue({ data: MEMBERS } as ReturnType<
      typeof useOrgMembers
    >);
    const fetchMock = installFetch();
    const onStarted = vi.fn();

    render(
      <StartSprintDialog
        orgId="o1"
        projectId="p1"
        interval={{ id: "c1", name: "Sprint 5", goal: null }}
        onClose={() => {}}
        onStarted={onStarted}
      />,
    );

    await screen.findByLabelText("Capacity (pts) for Alice");

    // Drop Bob to 50% availability → his effective capacity becomes 4.
    const bobAvail = screen.getByLabelText("Availability % for Bob");
    await userEvent.clear(bobAvail);
    await userEvent.type(bobAvail, "50");

    await userEvent.click(screen.getByRole("button", { name: "Start sprint" }));

    await waitFor(() => expect(onStarted).toHaveBeenCalled());

    const capBody = bodyOf(fetchMock, (u) => u.endsWith("/capacity"));
    expect(capBody.entries).toEqual([
      { userId: "u1", capacity: 10 },
      { userId: "u2", capacity: 4 },
    ]);

    // The activate PUT (basePath, no suffix) flips status to ACTIVE.
    const activateBody = bodyOf(
      fetchMock,
      (u) => u.endsWith("/intervals/c1") && !u.endsWith("/capacity"),
    );
    expect(activateBody.status).toBe("ACTIVE");
  });
});
