// @vitest-environment jsdom
//
// "Export CSV" on Time Tracking (COSMOS-199): it exports exactly the entries the
// view loaded, with project and CLIN names rather than ids, and names the file
// after whose time it is.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { parseCSV } from "@/lib/export/csv";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
const { downloadBlob } = vi.hoisted(() => ({ downloadBlob: vi.fn() }));
vi.mock("@/lib/export/download", () => ({ downloadBlob }));

import { TimeTracker } from "./time-tracker";

const ORG = "org-1";
let entries: unknown[] = [];

const ENTRY = {
  id: "e1",
  orgId: ORG,
  userId: "me",
  projectId: "p1",
  workItemId: null,
  clinId: "c1",
  date: "2026-10-20T00:00:00.000Z",
  hours: 7.5,
  rate: null,
  client: null,
  description: "Importer, then review",
  billableType: "BILLABLE",
  status: "DRAFT",
  approvedById: null,
  approvedAt: null,
  billedHours: null,
  billedById: null,
  billedAt: null,
  tags: [],
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
};

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  downloadBlob.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/time-entries/people")) return json({ data: [{ userId: "me", isSelf: true, displayName: "Me" }] });
      if (url.includes("/time-entries/my-approvers")) return json({ data: [] });
      if (url.includes("/time-entries?")) return json({ data: entries, total: entries.length });
      if (url.endsWith("/projects/p1/clins")) return json({ data: [{ id: "c1", code: "0001", title: "Engineering" }] });
      if (url.endsWith("/projects")) return json([{ id: "p1", name: "Dry Dock", key: "DRYDOCK" }]);
      return json({ data: [] });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TimeTracker — Export CSV", () => {
  it("downloads the loaded entries with project and CLIN names", async () => {
    entries = [ENTRY];
    render(<TimeTracker orgId={ORG} selfUserId="me" />);

    const button = await screen.findByRole("button", { name: /Export CSV/ });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);

    await waitFor(() => expect(downloadBlob).toHaveBeenCalledOnce());
    const [blob, filename] = downloadBlob.mock.calls[0] as [Blob, string];
    expect(filename).toMatch(/^time-mine-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
    const { rows } = parseCSV(await blob.text());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      Date: "2026-10-20",
      Hours: "7.5",
      Project: "Dry Dock",
      CLIN: "0001 — Engineering",
      Description: "Importer, then review",
      Status: "Draft",
    });
  });

  it("is disabled when there is nothing to export", async () => {
    entries = [];
    render(<TimeTracker orgId={ORG} selfUserId="me" />);

    const button = await screen.findByRole("button", { name: /Export CSV/ });
    // Give the load a chance to settle; it must stay disabled with no entries.
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/time-entries?")));
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
