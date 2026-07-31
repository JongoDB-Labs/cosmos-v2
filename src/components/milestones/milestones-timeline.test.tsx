// @vitest-environment jsdom
//
// The edit dialog sends `dueDate` on EVERY submit — including a plain rename —
// and the API stores it. Since #529 a milestone that follows its linked work has
// its date derived on read, so that stored value is discarded immediately: the
// edit appears to work and then reverts, with nothing on screen explaining why.
//
// `autoStatus` is already the switch for "follow my linked work" and this dialog
// already exposes it, so the honest fix is to say so — the date field is not the
// user's to type while it is derived, and turning Auto status off hands it back.
// These drive the real dialog rather than a helper, because the reported symptom
// was what the screen let someone do.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MilestonesTimeline } from "./milestones-timeline";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/lib/query/use-org-mutation", () => ({
  useOrgMutation: ({ mutationFn }: { mutationFn: (v: unknown) => unknown }) => ({
    mutate: (v: unknown) => mutationFn(v),
    isPending: false,
  }),
}));
vi.mock("@/lib/query/keys", () => ({ useOrgQueryKey: (...k: unknown[]) => k }));

const ORG = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";

/** One milestone, `links` and `autoStatus` set per test. */
function milestone(over: Record<string, unknown> = {}) {
  return {
    id: "m1",
    orgId: ORG,
    projectId: PROJECT,
    title: "Ship the thing",
    description: null,
    dueDate: "2026-03-01T12:00:00.000Z",
    status: "UPCOMING",
    autoStatus: true,
    completedAt: null,
    ownerId: null,
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    links: [{ id: "l1", milestoneId: "m1", workItemId: "wi-1", createdAt: "" }],
    ...over,
  };
}

function mockFetch(milestones: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = String(url).includes("/members") ? [] : milestones;
      // jsonFetch reads the body with res.text(), not res.json().
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify(body),
      } as unknown as Response;
    }),
  );
}

async function openEditDialog(milestones: unknown[]) {
  mockFetch(milestones);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MilestonesTimeline orgId={ORG} projectId={PROJECT} />
    </QueryClientProvider>,
  );
  const edit = await screen.findByRole("button", { name: "Edit milestone" }, { timeout: 5000 });
  fireEvent.click(edit);
  return await screen.findByLabelText(/due date/i);
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("milestone edit dialog — the due date field", () => {
  it("is read-only while the date follows linked work", async () => {
    // The reported shape: auto-managed, one linked ticket. Typing here would be
    // stored and then thrown away on the next read.
    const due = await openEditDialog([milestone()]);
    expect(due).toBeDisabled();
  });

  it("explains WHY, so the field isn't just mysteriously dead", async () => {
    await openEditDialog([milestone()]);
    expect(screen.getByText(/follows the planned end date of the linked work/i)).toBeTruthy();
  });

  it("is editable for a milestone that is managed by hand", async () => {
    const due = await openEditDialog([milestone({ autoStatus: false })]);
    expect(due).not.toBeDisabled();
  });

  it("is editable for an auto-managed milestone with nothing linked", async () => {
    // Nothing to follow, so the stored date is the only date there is.
    const due = await openEditDialog([milestone({ links: [] })]);
    expect(due).not.toBeDisabled();
  });

  it("hands the field back the moment Auto status is switched off", async () => {
    // Without a save — otherwise the way to regain control would be to save an
    // edit you cannot make yet.
    const due = await openEditDialog([milestone()]);
    expect(due).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/auto status/i));
    await waitFor(() => expect(screen.getByLabelText(/due date/i)).not.toBeDisabled());
  });
});
