// @vitest-environment jsdom
//
// COSMOS-214 follow-up — "Export CSV" must never write rows that belong to a
// different selection than the one it names.
//
// `load()` does not clear `entries`, and the filename is built from the CURRENT
// `personId` / week while the rows come from state. So any window where the
// button is live during a reload exports the PREVIOUS selection under the NEW
// selection's name — and TIME_CSV_COLUMNS carries no person column, so nothing
// in the file reveals the swap. Worse at mount: `shownUserId` is "" until the
// people fetch resolves, and "" means unscoped, which for a TIME_READ_ALL holder
// is every entry in the org.
//
// These lock both halves of the fix:
//   - mount issues ONE entries request, already scoped to the viewer;
//   - while a reload is in flight the button is disabled and a click writes
//     nothing;
//   - once the reload settles the export is the NEW selection's rows.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { parseCSV } from "@/lib/export/csv";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
const { downloadBlob } = vi.hoisted(() => ({ downloadBlob: vi.fn() }));
vi.mock("@/lib/export/download", () => ({ downloadBlob }));

import { TimeTracker } from "./time-tracker";

const ORG = "org-1";

function entry(id: string, description: string, date: string) {
  return {
    id,
    orgId: ORG,
    userId: "me",
    projectId: "p1",
    workItemId: null,
    clinId: null,
    date: `${date}T00:00:00.000Z`,
    hours: 3,
    rate: null,
    client: null,
    description,
    billableType: "BILLABLE",
    status: "DRAFT",
    approvedById: null,
    approvedAt: null,
    billedHours: null,
    billedById: null,
    billedAt: null,
    tags: [],
    createdAt: `${date}T00:00:00.000Z`,
    updatedAt: `${date}T00:00:00.000Z`,
  };
}

function json(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

/** Every `/time-entries?` request this render made, newest last. */
let entryRequests: string[] = [];
/** Queue of responders for `/time-entries?`, one per request, in order. */
let responders: ((url: string) => Promise<Response>)[] = [];

function install() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/time-entries/people"))
        return json({ data: [{ userId: "me", isSelf: true, displayName: "Me" }] });
      if (url.includes("/time-entries/my-approvers")) return json({ data: [] });
      if (url.includes("/time-entries?")) {
        entryRequests.push(url);
        const responder = responders.shift();
        // Default: an empty week. Explicit responders cover the cases under test.
        return responder ? responder(url) : json({ data: [], total: 0 });
      }
      if (url.endsWith("/projects")) return json([{ id: "p1", name: "Dry Dock", key: "DRYDOCK" }]);
      return json({ data: [] });
    }),
  );
}

const param = (url: string, name: string) =>
  new URL(url, "http://localhost").searchParams.get(name);

beforeEach(() => {
  downloadBlob.mockReset();
  entryRequests = [];
  responders = [];
  install();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const exportButton = () => screen.getByRole("button", { name: /Export CSV/ }) as HTMLButtonElement;

describe("TimeTracker — Export CSV matches the selection it names", () => {
  it("loads entries once on mount, already scoped to the viewer", async () => {
    responders = [(url) => json({ data: [entry("a", "Mine", param(url, "startDate")!)], total: 1 })];
    render(<TimeTracker orgId={ORG} />);

    await waitFor(() => expect(exportButton().disabled).toBe(false));
    // Settle anything else the mount kicked off.
    await new Promise((r) => setTimeout(r, 50));

    // Exactly one entries request, and it names the person. Before the fix this
    // was two: one with no userId — every entry in the org for a TIME_READ_ALL
    // holder — then one scoped to the viewer.
    expect(entryRequests).toHaveLength(1);
    expect(param(entryRequests[0], "userId")).toBe("me");
  });

  it("refuses to export while a reload is in flight, instead of writing the previous week", async () => {
    responders = [
      (url) => json({ data: [entry("a", "Week one", param(url, "startDate")!)], total: 1 }),
      // The next week's request never settles: this IS the reload window.
      () => new Promise<Response>(() => {}),
    ];
    render(<TimeTracker orgId={ORG} />);
    await waitFor(() => expect(exportButton().disabled).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "Next week" }));

    // Week one's rows are still in state and on screen, but they are no longer
    // what the controls describe — so the button must not offer to write them.
    await waitFor(() => expect(exportButton().disabled).toBe(true));
    fireEvent.click(exportButton());
    await new Promise((r) => setTimeout(r, 50));
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("exports the new week once its reload settles", async () => {
    responders = [
      (url) => json({ data: [entry("a", "Week one", param(url, "startDate")!)], total: 1 }),
      (url) => json({ data: [entry("b", "Week two", param(url, "startDate")!)], total: 1 }),
    ];
    render(<TimeTracker orgId={ORG} />);
    await waitFor(() => expect(exportButton().disabled).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(entryRequests).toHaveLength(2));
    await waitFor(() => expect(exportButton().disabled).toBe(false));

    fireEvent.click(exportButton());
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledOnce());

    const [blob, filename] = downloadBlob.mock.calls[0] as [Blob, string];
    const { rows } = parseCSV(await blob.text());
    // The rows are week two's, and the filename names week two — the pairing is
    // the whole point, so assert them against the same request.
    expect(rows).toHaveLength(1);
    expect(rows[0].Description).toBe("Week two");
    expect(rows[0].Date).toBe(param(entryRequests[1], "startDate"));
    expect(filename).toBe(
      `time-mine-${param(entryRequests[1], "startDate")}-to-${param(entryRequests[1], "endDate")}.csv`,
    );
  });
});
