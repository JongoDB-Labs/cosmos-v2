// @vitest-environment jsdom
//
// The week on screen is ONE person's: a TIME_READ_ALL holder who sends no
// userId gets every entry in the org. So no entries or timesheet request may
// go out unscoped, not even the first one, and not when the people list (the
// picker) is slow or fails. The signed-in user comes in as a prop for exactly
// this reason.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));

import { TimeTracker } from "./time-tracker";

const ORG = "org-1";

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

function stubFetch(people: () => Promise<Response>) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/time-entries/people")) return people();
    if (url.includes("/time-entries?")) return json({ data: [], total: 0 });
    return json({ data: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requests(fetchMock: ReturnType<typeof stubFetch>, path: string): URL[] {
  return fetchMock.mock.calls
    .map(([input]) => new URL(String(input), "http://x"))
    .filter((u) => u.pathname === `/api/v1/orgs/${ORG}/${path}`);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TimeTracker scopes every load to one person", () => {
  it.each([
    ["is still pending", () => new Promise<Response>(() => {})],
    ["fails", () => json({ error: "boom" }, 500)],
  ])("while the people list %s", async (_label, people) => {
    const fetchMock = stubFetch(people);
    render(<TimeTracker orgId={ORG} selfUserId="me" />);

    await waitFor(() => expect(requests(fetchMock, "time-entries").length).toBeGreaterThan(0));
    await waitFor(() => expect(requests(fetchMock, "timesheets").length).toBeGreaterThan(0));

    for (const u of [...requests(fetchMock, "time-entries"), ...requests(fetchMock, "timesheets")]) {
      expect(u.searchParams.get("userId"), u.toString()).toBe("me");
    }
  });
});
