// @vitest-environment jsdom
//
// The overlays on Program Management's calendar: each one switched on and off
// on its own, remembered per viewer, operable from the keyboard, and never
// silent when it fails. And the project tab, which passes no overlays, must
// render the calendar it always did.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  usePathname: () => "/acme/program-management",
  useParams: () => ({ orgSlug: "acme" }),
  useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/lib/query/json-fetcher", async (orig) => ({
  ...(await orig<typeof import("@/lib/query/json-fetcher")>()),
  jsonFetch: vi.fn(),
}));

import { ProgramCalendar, type CalendarOverlays } from "./program-calendar";
import { FetchError, jsonFetch } from "@/lib/query/json-fetcher";
import type { AgilePayload } from "@/lib/program-calendar/overlays";

const CATEGORY = { id: "c1", name: "Reviews", tintRgb: "99 102 241", tintAlpha: 0.2, textColor: "#3730A3" };
const EVENT = {
  id: "e1", title: "Program review", startsAt: "2027-01-12T00:00:00.000Z", endsAt: "2027-01-13T00:00:00.000Z",
  allDay: true, timeZone: "UTC", location: null, attendees: "", recurrence: "NONE", customerAttending: false,
  description: "", showOnDashboard: false, deliverableId: null, category: CATEGORY, ownerTeam: null, ownerMember: null,
};
const AGILE: AgilePayload = {
  intervals: [
    {
      id: "i1", name: "Sprint 4", kind: "SPRINT", startDate: "2027-01-04T00:00:00.000Z",
      endDate: "2027-01-08T00:00:00.000Z", projectKey: "WEB", projectName: "Website",
    },
  ],
  due: [{ id: "w1", key: "WEB-12", title: "Draft plan", dueDate: "2027-01-21T00:00:00.000Z", resolved: false }],
  dueCapped: false,
};

let agileResponse: () => Promise<unknown> = async () => AGILE;
let eventsResponse: () => unknown[] = () => [EVENT];

const calls = (fragment: string) =>
  vi.mocked(jsonFetch).mock.calls.filter(([url]) => String(url).includes(fragment)).length;

function overlays(storageKey = "cosmos:pm-calendar-overlays:o1:u1"): CalendarOverlays {
  return {
    storageKey,
    orgSlug: "acme",
    milestones: [{ id: "m1", title: "Exercise A readiness", dueDate: "2027-01-20T00:00:00.000Z", projectKey: "WEB" }],
  };
}

function mount(o?: CalendarOverlays) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProgramCalendar orgId="o1" canCreate={false} owners={[]} deliverables={[]} overlays={o} />
    </QueryClientProvider>,
  );
}

const toggle = (name: "Events" | "Agile") =>
  within(screen.getByRole("group", { name: "Overlays" })).getByRole("button", { name: new RegExp(`^${name}`) });

beforeEach(() => {
  // Only the clock: React Query's own timers stay real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-01-15T12:00:00.000Z"));
  window.localStorage.clear();
  agileResponse = async () => AGILE;
  eventsResponse = () => [EVENT];
  vi.mocked(jsonFetch).mockImplementation(async (url) => {
    const u = String(url);
    if (u.includes("/program-events?")) return eventsResponse() as never;
    if (u.includes("/event-categories?")) return [{ ...CATEGORY, count: 1 }] as never;
    if (u.includes("/program-calendar/agile?")) return (await agileResponse()) as never;
    throw new Error(`unexpected fetch ${u}`);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("the project tab, which has no overlays", () => {
  it("renders the calendar it always did: events, no toggles, no Agile fetch", async () => {
    mount();
    expect(await screen.findByText("Program review")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Overlays" })).toBeNull();
    expect(screen.queryByText("Exercise A readiness")).toBeNull();
    expect(calls("/program-calendar/agile")).toBe(0);
  });
});

describe("each overlay switches on and off on its own", () => {
  it("first visit: Events on, Agile off and not fetched", async () => {
    mount(overlays());
    expect(await screen.findByText("Program review")).toBeTruthy();
    expect(screen.getByText("Exercise A readiness")).toBeTruthy();
    expect(toggle("Events").getAttribute("aria-pressed")).toBe("true");
    expect(toggle("Agile").getAttribute("aria-pressed")).toBe("false");
    expect(calls("/program-calendar/agile")).toBe(0);
  });

  it("Agile on fetches and draws sprints and due dates alongside the events; off removes them", async () => {
    mount(overlays());
    await screen.findByText("Program review");
    fireEvent.click(toggle("Agile"));

    expect(await screen.findByText("Sprint 4")).toBeTruthy();
    expect(screen.getByText("WEB-12 Draft plan")).toBeTruthy();
    // The events are still there: turning one overlay on leaves the other alone.
    expect(screen.getByText("Program review")).toBeTruthy();
    expect(calls("/program-calendar/agile")).toBe(1);
    expect(toggle("Agile").getAttribute("aria-pressed")).toBe("true");
    expect(within(screen.getByRole("list", { name: "Legend" })).getByText("Sprint")).toBeTruthy();

    fireEvent.click(toggle("Agile"));
    await waitFor(() => expect(screen.queryByText("Sprint 4")).toBeNull());
    expect(screen.getByText("Program review")).toBeTruthy();
  });

  it("Events off removes events and milestones, stops fetching them, and disables their filters", async () => {
    mount(overlays());
    await screen.findByText("Program review");
    // Positive control: with Events on, the filters work and moving the window refetches.
    expect((screen.getByRole("button", { name: /^Categories/ }) as HTMLButtonElement).disabled).toBe(false);
    const before = calls("/program-events?");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(calls("/program-events?")).toBe(before + 1));
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    await screen.findByText("Program review");

    fireEvent.click(toggle("Events"));
    await waitFor(() => expect(screen.queryByText("Program review")).toBeNull());
    expect(screen.queryByText("Exercise A readiness")).toBeNull();
    for (const name of [/^Owners/, /^Categories/, /^Filters/]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }

    const off = calls("/program-events?");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    // Give a fetch that should not happen the chance to.
    await new Promise((r) => setTimeout(r, 50));
    expect(calls("/program-events?")).toBe(off);
  });

  it("both on draws every kind; overlay chips are links that say what they are", async () => {
    mount(overlays());
    await screen.findByText("Program review");
    fireEvent.click(toggle("Agile"));
    const sprint = await screen.findByRole("link", { name: "Sprint: Sprint 4 (Website)" });
    expect(sprint.getAttribute("href")).toBe("/acme/projects/WEB/intervals");
    expect(screen.getByRole("link", { name: "Milestone: Exercise A readiness" }).getAttribute("href")).toBe(
      "/acme/projects/WEB/milestones",
    );
    expect(screen.getByRole("link", { name: "Due: WEB-12 Draft plan" }).getAttribute("href")).toBe(
      "/acme/work-items?item=w1",
    );
    // A program event is still a button that opens it here, not a link away.
    expect(screen.getByRole("button", { name: /Program review/ })).toBeTruthy();
  });

  it("with every overlay off, the page says so rather than showing a bare grid", async () => {
    mount(overlays());
    await screen.findByText("Program review");
    fireEvent.click(toggle("Events"));
    expect(await screen.findByText(/Every overlay is off/)).toBeTruthy();
  });
});

describe("a busy day does not hide the cadence", () => {
  it("the events keep their three lanes, so the week's sprint still shows and the rest is \"+3 more\"", async () => {
    // Six events on the Tuesday of Sprint 4's week.
    eventsResponse = () =>
      [1, 2, 3, 4, 5, 6].map((i) => ({
        ...EVENT, id: `e${i}`, title: `Review ${i}`,
        startsAt: "2027-01-05T00:00:00.000Z", endsAt: "2027-01-06T00:00:00.000Z",
      }));
    mount(overlays());
    await screen.findByText("Review 1");
    fireEvent.click(toggle("Agile"));
    expect(await screen.findByRole("link", { name: "Sprint: Sprint 4 (Website)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "+3 more" })).toBeTruthy();
  });
});

describe("the toggles are remembered for this viewer", () => {
  it("survive a reload under the same key", async () => {
    const first = mount(overlays());
    await screen.findByText("Program review");
    fireEvent.click(toggle("Agile"));
    fireEvent.click(toggle("Events"));
    first.unmount();

    mount(overlays());
    await waitFor(() => expect(toggle("Agile").getAttribute("aria-pressed")).toBe("true"));
    expect(toggle("Events").getAttribute("aria-pressed")).toBe("false");
    expect(await screen.findByText("Sprint 4")).toBeTruthy();
  });

  it("are not inherited by another person on the same browser", async () => {
    const first = mount(overlays("cosmos:pm-calendar-overlays:o1:u1"));
    await screen.findByText("Program review");
    fireEvent.click(toggle("Agile"));
    first.unmount();

    mount(overlays("cosmos:pm-calendar-overlays:o1:u2"));
    await screen.findByText("Program review");
    expect(toggle("Agile").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("the toggles work from the keyboard", () => {
  it("Tab reaches each toggle, and Space and Enter flip it", async () => {
    const user = userEvent.setup({ advanceTimers: () => undefined });
    mount(overlays());
    await screen.findByText("Program review");

    const events = toggle("Events");
    const agile = toggle("Agile");
    events.focus();
    await user.tab();
    expect(document.activeElement).toBe(agile);

    await user.keyboard(" ");
    expect(agile.getAttribute("aria-pressed")).toBe("true");
    await user.keyboard("{Enter}");
    expect(agile.getAttribute("aria-pressed")).toBe("false");

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(events);
    await user.keyboard("{Enter}");
    expect(events.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("an overlay that cannot load says so", () => {
  it("a refused Agile request shows the server's words, and the events stay", async () => {
    agileResponse = async () => {
      throw new FetchError(403, { error: "Not allowed here" }, "Not allowed here");
    };
    mount(overlays());
    await screen.findByText("Program review");
    fireEvent.click(toggle("Agile"));
    expect(await screen.findByText("The Agile overlay could not be loaded: Not allowed here")).toBeTruthy();
    expect(screen.getByText("Program review")).toBeTruthy();
  });

  it("a cut-off list of due dates says it was cut off", async () => {
    agileResponse = async () => ({ ...AGILE, dueCapped: true });
    mount(overlays());
    await screen.findByText("Program review");
    fireEvent.click(toggle("Agile"));
    expect(await screen.findByText(/Only the first 500 work items due in this period are shown/)).toBeTruthy();
  });

  it("control: a complete list says nothing of the kind", async () => {
    mount(overlays());
    await screen.findByText("Program review");
    fireEvent.click(toggle("Agile"));
    await screen.findByText("Sprint 4");
    expect(screen.queryByText(/Only the first/)).toBeNull();
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
  });
});
