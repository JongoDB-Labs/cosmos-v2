// @vitest-environment jsdom
//
// Workflow P4c: Project settings → Automations. The list says what each rule
// does, the switch turns one off at the revision read, templates and the
// builder send a spec the server's schema accepts, the server's refusals and
// cycle warnings are shown, and the run log says what each run did.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({ usePathname: () => "/acme/projects/PRJ/settings/automations", useRouter: () => ({ push: vi.fn() }) }));
const { toast } = vi.hoisted(() => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
const { jsonFetch } = vi.hoisted(() => ({ jsonFetch: vi.fn() }));
vi.mock("@/lib/query/json-fetcher", async (orig) => ({ ...(await orig<object>()), jsonFetch }));

import { FetchError } from "@/lib/query/json-fetcher";
import { automationSpecSchema } from "@/lib/automation/spec";
import { AutomationsOverview } from "./automations-overview";

const BASE = "/api/v1/orgs/o1/automations";
const STATUSES = [
  { id: "s1", key: "todo", name: "To Do", color: "#999", category: "TODO", sortOrder: 0, archived: false },
  { id: "s2", key: "doing", name: "Doing", color: "#999", category: "IN_PROGRESS", sortOrder: 1, archived: false },
  { id: "s3", key: "shipped", name: "Shipped", color: "#999", category: "DONE", sortOrder: 2, archived: false },
  { id: "s4", key: "dropped", name: "Dropped", color: "#999", category: "CANCELLED", sortOrder: 3, archived: false },
];
const rule = (over: Record<string, unknown> = {}) => ({
  id: "r1", projectId: "p1", name: "Ship it", enabled: true, revision: 3, ownerId: "u1", allowChain: false, templateKey: null, disabledReason: null,
  createdAt: "2026-10-24T00:00:00.000Z", updatedAt: "2026-10-24T00:00:00.000Z",
  spec: { trigger: { on: "item.transitioned", toCategory: ["DONE"] }, scope: "parent", condition: { childrenAll: { categories: ["DONE", "CANCELLED"] } }, actions: [{ kind: "transition", to: "shipped" }], options: { includeImports: false } },
  ...over,
});
let rules: ReturnType<typeof rule>[] = [];
let saveResult: (body: Record<string, unknown>) => unknown = (body) => ({ ...rule(), ...body, id: "r9", warnings: [] });

beforeEach(() => {
  rules = [
    rule(),
    rule({
      id: "r2", name: "Old sweep", enabled: false, disabledReason: "Its owner is no longer a member. Save the rule to take it over.",
      spec: { trigger: { on: "schedule", every: "week", hour: 7, minute: 30, cql: "statusCategory = DONE" }, scope: "trigger", actions: [{ kind: "archive" }], options: { includeImports: false } },
    }),
  ];
  saveResult = (body) => ({ ...rule(), ...body, id: "r9", warnings: [] });
  toast.success.mockReset();
  toast.error.mockReset();
  jsonFetch.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" || init?.method === "PATCH") return saveResult(JSON.parse(String(init.body)));
    if (init?.method === "DELETE") return { deleted: true };
    if (url === `${BASE}?projectId=p1`) return rules;
    if (url.endsWith("/statuses?archived=true&counts=true")) return STATUSES;
    if (url === `${BASE}/r1/runs?limit=50`) {
      return [
        { id: "x1", ruleRevision: 3, eventId: "7", depth: 1, status: "PARTIAL", itemsMatched: 1, durationMs: 4, createdAt: "2026-10-24T10:00:00.000Z",
          actions: [{ kind: "transition", itemId: "i1", ok: false, error: "The workflow has no move from To Do to Shipped." }, { kind: "addComment", itemId: "i1", ok: true }] },
        { id: "x2", ruleRevision: 3, eventId: "8", depth: 11, status: "LOOP", itemsMatched: 0, durationMs: 1, createdAt: "2026-10-24T09:00:00.000Z", actions: [{ note: "Chain deeper than 10 automations." }] },
      ];
    }
    return [];
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderOverview() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AutomationsOverview orgId="o1" projectId="p1" canManageWebhooks={false} />
    </QueryClientProvider>,
  );
}

const sent = (method: string) => jsonFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === method);
const lastBody = (method: string) => JSON.parse(String((sent(method).at(-1)![1] as RequestInit).body));

describe("AutomationsOverview", () => {
  it("lists each rule in a sentence, and says why one was switched off", async () => {
    renderOverview();
    const list = await screen.findByRole("list", { name: "Automation rules" });
    expect(within(list).getByText(/When an item moves to any Done status, on its parent, if every child is done or cancelled: move to Shipped\./)).toBeTruthy();
    expect(within(list).getByText("Every Monday at 07:30 UTC, for items matching statusCategory = DONE: archive.")).toBeTruthy();
    expect(within(list).getByText(/Switched off: Its owner is no longer a member/)).toBeTruthy();
    expect(within(list).getByText("Off")).toBeTruthy();
  });

  it("switches a rule off at the revision it read", async () => {
    renderOverview();
    fireEvent.click(await screen.findByRole("switch", { name: "Run Ship it" }));
    await waitFor(() => expect(sent("PATCH")).toHaveLength(1));
    expect(sent("PATCH")[0][0]).toBe(`${BASE}/r1`);
    expect(lastBody("PATCH")).toEqual({ revision: 3, enabled: false });
  });

  it("creates a template's rule with what was picked, and shows the cycle warning the save returns", async () => {
    saveResult = (body) => ({ ...rule(), ...body, id: "r9", warnings: ["These rules can keep firing each other: A → B → A."] });
    const user = userEvent.setup();
    renderOverview();
    await user.click(await screen.findByRole("button", { name: "Start from a template" }));
    await user.click(screen.getByRole("radio", { name: "Close stale items" }));
    fireEvent.change(screen.getByLabelText("Untouched for (days)"), { target: { value: "14" } });
    await user.click(screen.getByRole("button", { name: "Create rule" }));
    await waitFor(() => expect(sent("POST")).toHaveLength(1));
    const body = lastBody("POST");
    expect(body).toMatchObject({ projectId: "p1", name: "Close stale items", templateKey: "close-stale", allowChain: false });
    const spec = automationSpecSchema.parse(body.spec);
    expect(spec.trigger).toMatchObject({ on: "schedule", cql: expect.stringContaining("updated < -14d") });
    // The project's own Cancelled status, with the reason.
    expect(spec.actions[0]).toEqual({ kind: "transition", to: "dropped", cancel: { reason: "OBE" } });
    expect(await screen.findByText(/These rules can keep firing each other: A → B → A\./)).toBeTruthy();
    // The list is read again, so the new rule shows.
    await waitFor(() => expect(jsonFetch.mock.calls.filter(([url]) => url === `${BASE}?projectId=p1`).length).toBe(2));
  });

  it("builds a rule from the builder: nothing is sent without a name, then the spec the form shows", async () => {
    const user = userEvent.setup();
    renderOverview();
    await user.click(await screen.findByRole("button", { name: "New rule" }));
    await user.click(screen.getByRole("button", { name: "Save rule" }));
    expect(await screen.findByText("Give the rule a name.")).toBeTruthy();
    expect(sent("POST")).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Rule name"), { target: { value: "  Label hot items " } });
    fireEvent.change(screen.getByLabelText("Condition query"), { target: { value: "priority = HIGH" } });
    fireEvent.click(screen.getByLabelText("Only when every child is settled"));
    await user.click(screen.getByLabelText("Action 1"));
    await user.click(await screen.findByRole("option", { name: "Add labels" }));
    fireEvent.change(screen.getByLabelText("Action 1 labels"), { target: { value: "hot, urgent ," } });
    await user.click(screen.getByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(sent("POST")).toHaveLength(1));
    const body = lastBody("POST");
    expect(body.name).toBe("Label hot items");
    expect(body.spec).toEqual({
      trigger: { on: "item.transitioned", toCategory: ["DONE"] },
      scope: "trigger",
      condition: { cql: "priority = HIGH", childrenAll: { categories: ["DONE", "CANCELLED"] } },
      actions: [{ kind: "addLabels", labels: ["hot", "urgent"] }],
      options: { includeImports: false },
    });
  });

  it("edits at the revision read, and shows every issue the server refuses it for", async () => {
    saveResult = () => {
      throw new FetchError(422, { code: "automation_invalid", issues: [{ path: "actions.0.to", message: 'The project has no status "gone".' }, { path: "condition.cql", message: "Unknown field nonsense." }] }, "422");
    };
    const user = userEvent.setup();
    renderOverview();
    await user.click((await screen.findAllByRole("button", { name: "Edit" }))[0]);
    await user.click(screen.getByRole("button", { name: "Save rule" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText('The project has no status "gone".')).toBeTruthy();
    expect(within(alert).getByText("Unknown field nonsense.")).toBeTruthy();
    expect(sent("PATCH")[0][0]).toBe(`${BASE}/r1`);
    expect(lastBody("PATCH")).toMatchObject({ revision: 3, name: "Ship it", allowChain: false });
    // Still open: nothing was saved.
    expect(screen.getByRole("button", { name: "Save rule" })).toBeTruthy();
  });

  it("shows a rule's runs: what each did, and why an action failed", async () => {
    const user = userEvent.setup();
    renderOverview();
    await user.click((await screen.findAllByRole("button", { name: "Runs" }))[0]);
    const runs = await screen.findByRole("list", { name: "Runs" });
    expect(within(runs).getByText("Partly done")).toBeTruthy();
    expect(within(runs).getByText("transition: The workflow has no move from To Do to Shipped.")).toBeTruthy();
    expect(within(runs).getByText("1 item, 1 change")).toBeTruthy();
    expect(within(runs).getByText("Loop stopped")).toBeTruthy();
    expect(within(runs).getByText("Chain deeper than 10 automations.")).toBeTruthy();
  });

  it("deletes a rule only once confirmed", async () => {
    const user = userEvent.setup();
    renderOverview();
    const first = (await screen.findAllByRole("listitem"))[0];
    await user.click(within(first).getByRole("button", { name: "Delete" }));
    expect(sent("DELETE")).toHaveLength(0);
    await user.click(within(first).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(sent("DELETE")).toHaveLength(1));
    expect(sent("DELETE")[0][0]).toBe(`${BASE}/r1`);
  });
});
