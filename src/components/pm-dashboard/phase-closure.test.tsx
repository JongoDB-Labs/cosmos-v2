// @vitest-environment jsdom
//
// Close / Reopen for a phase: close goes through the closing rule's prompt when
// the server asks for a reason, reopen asks for confirmation first, both are
// offered only with PROJECT_UPDATE, the closed state names who and when, and
// the caller is told after each change so it can refresh. The drawer shows the
// control only for a phase.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const perms = vi.hoisted(() => ({ canUpdate: true }));
vi.mock("next/navigation", () => ({ usePathname: () => "/acme/projects/P1" }));
vi.mock("@/lib/errors/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/components/providers/permissions-provider", async (orig) => {
  const real = await orig<typeof import("@/components/providers/permissions-provider")>();
  return {
    ...real,
    usePermissions: () => ({ can: (bit: bigint) => bit === real.Permission.PROJECT_UPDATE && perms.canUpdate }),
  };
});

import { PhaseClosure } from "./phase-closure";
import { PmEntityDrawer } from "./pm-entity-drawer";

type Call = { url: string; body: unknown };
let calls: Call[] = [];
let respond: (url: string, body: Record<string, unknown>) => Response;

beforeEach(() => {
  calls = [];
  perms.canUpdate = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}"));
        calls.push({ url, body });
        return respond(url, body);
      }
      return new Response("[]");
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const OPEN = { id: "ph1", name: "Design development", closedAt: null };
const CLOSED = { id: "ph1", name: "Design development", closedAt: "2026-10-30T12:00:00.000Z", closedByName: "Avery" };

describe("PhaseClosure", () => {
  it("closes a phase, asking for the reason when the rule wants one, then shows who closed it", async () => {
    respond = (_url, body) =>
      body.closeEvidenceNote
        ? json({ id: "ph1", name: "Design development", closedAt: "2026-11-04T10:00:00.000Z", closedById: "me", closeEvidenceNote: body.closeEvidenceNote })
        : json({ code: "close_evidence_required", error: "Attach a supporting file, or record why one isn't needed" }, 422);
    const onChanged = vi.fn();
    render(<PhaseClosure orgId="o1" projectId="p1" phase={OPEN} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Close phase" }));
    fireEvent.change(await screen.findByLabelText("Reason no file is needed"), { target: { value: "Client sign-off by email" } });
    fireEvent.click(screen.getByText("Record and close"));
    await waitFor(() => expect(screen.getByTestId("phase-closure").textContent).toContain("by you"));
    expect(calls.map((c) => [c.url, c.body])).toEqual([
      ["/api/v1/orgs/o1/projects/p1/phases/ph1/close", {}],
      ["/api/v1/orgs/o1/projects/p1/phases/ph1/close", { closeEvidenceNote: "Client sign-off by email" }],
    ]);
    expect(onChanged).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Reopen phase" })).toBeTruthy();
  });

  it("a closed phase says who closed it and when; reopening asks first, then reopens", async () => {
    respond = () => json({ id: "ph1", name: "Design development", closedAt: null, closedById: null, closeEvidenceNote: null });
    const onChanged = vi.fn();
    render(<PhaseClosure orgId="o1" projectId="p1" phase={CLOSED} onChanged={onChanged} />);
    expect(screen.getByTestId("phase-closure").textContent).toMatch(/Closed .*2026.* by Avery/);

    fireEvent.click(screen.getByRole("button", { name: "Reopen phase" }));
    expect(await screen.findByText("Reopen Design development?")).toBeTruthy();
    expect(calls).toEqual([]); // nothing is sent until it's confirmed
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(screen.getByTestId("phase-closure").textContent).toContain("Open"));
    expect(calls.map((c) => c.url)).toEqual(["/api/v1/orgs/o1/projects/p1/phases/ph1/reopen"]);
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("cancelling the reopen confirmation sends nothing", async () => {
    respond = () => json({});
    render(<PhaseClosure orgId="o1" projectId="p1" phase={CLOSED} />);
    fireEvent.click(screen.getByRole("button", { name: "Reopen phase" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByText("Reopen Design development?")).toBeNull());
    expect(calls).toEqual([]);
  });

  it("without PROJECT_UPDATE: the state is shown, the buttons are not", () => {
    perms.canUpdate = false;
    render(<PhaseClosure orgId="o1" projectId="p1" phase={CLOSED} />);
    expect(screen.getByTestId("phase-closure").textContent).toContain("by Avery");
    expect(screen.queryByRole("button", { name: /phase/ })).toBeNull();
  });

  it("a refused close leaves it open and doesn't report a change", async () => {
    respond = () => json({ code: "forbidden", error: "nope" }, 403);
    const onChanged = vi.fn();
    render(<PhaseClosure orgId="o1" projectId="p1" phase={OPEN} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Close phase" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Close phase" })).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe("PmEntityDrawer + phase closure", () => {
  const drawer = (extra: Record<string, unknown>) =>
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <PmEntityDrawer
          orgId="o1"
          projectId="p1"
          subjectType="milestone"
          subjectId="ph1"
          title="Design development"
          fields={[]}
          patchPath="/x"
          open
          onOpenChange={() => {}}
          {...extra}
        />
      </QueryClientProvider>,
    );

  it("shows Close/Reopen when given a phase", () => {
    drawer({ phaseClosure: { phase: OPEN } });
    expect(screen.getByRole("button", { name: "Close phase" })).toBeTruthy();
  });

  it("shows nothing of the kind for any other record", () => {
    drawer({});
    expect(screen.queryByTestId("phase-closure")).toBeNull();
  });
});
