// @vitest-environment jsdom
// Task 3 — the Manage-roles dialog: one place for an org admin to set a
// member's PRIMARY TIER (the 5-tier org role) AND their ADDITIONAL WORK-ROLES.
// These tests lock its contract:
//   (a) renders the tier select + the additional-roles multi-select
//   (b) an ungrantable role is disabled — UNLESS the member already holds it
//       (de-escalation: an already-assigned role stays enabled/removable)
//   (c) an OWNER's tier is static text and never PUTs the tier on save
//   (d) a changed tier + changed roles save as two PUTs, in order, right bodies
//   (e) a roles-PUT 403 after a successful tier save shows the exact partial-
//       failure message and keeps the dialog open
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// --- base-ui needs these in jsdom (see memory: testing-base-ui-in-jsdom) ---
beforeAll(() => {
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
  for (const m of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture"] as const) {
    if (!Element.prototype[m]) {
      // @ts-expect-error — no-op pointer-capture stubs for jsdom
      Element.prototype[m] = () => {};
    }
  }
});

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

import { TeamRoleDialog } from "./team-role-dialog";

const WORK_ROLE_OPTIONS = [
  { id: "wr-analyst", name: "Analyst", isBuiltIn: true },
  { id: "wr-lead", name: "Security Lead", isBuiltIn: false },
  { id: "wr-super", name: "Superuser", isBuiltIn: false },
  { id: "wr-root", name: "Root Access", isBuiltIn: false },
];
// The actor may grant Analyst + Security Lead, but NOT Superuser / Root Access.
const GRANTABLE = ["wr-analyst", "wr-lead"];

type FetchCall = { url: string; method: string; body: unknown };
let calls: FetchCall[] = [];

function mockFetch(overrides?: { rolesStatus?: number; rolesError?: string }) {
  calls = [];
  global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    calls.push({
      url: u,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    // work-roles PUT — optionally forced to fail with a server error body.
    if (u.endsWith("/work-roles") && method === "PUT") {
      const status = overrides?.rolesStatus ?? 200;
      if (status !== 200) {
        return new Response(
          JSON.stringify({ error: overrides?.rolesError ?? "denied" }),
          { status, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ workRoleIds: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // tier PUT (…/members/[id]) + anything else — succeeds.
    return new Response(JSON.stringify({ id: "m1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

type Member = { id: string; name: string; role: string; workRoleIds: string[] };

function renderDialog(member: Member) {
  const onClose = vi.fn();
  render(
    <TeamRoleDialog
      orgId="org-1"
      member={member}
      workRoleOptions={WORK_ROLE_OPTIONS}
      grantableRoleIds={GRANTABLE}
      onClose={onClose}
    />,
  );
  return { onClose };
}

const puts = () => calls.filter((c) => c.method === "PUT");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TeamRoleDialog — unified tier + work-role assignment", () => {
  it("renders the tier select, the additional-roles multi-select, and the footer hint (a)", () => {
    mockFetch();
    renderDialog({ id: "m1", name: "Ada", role: "MEMBER", workRoleIds: [] });

    expect(screen.getByLabelText("Primary tier")).toBeInTheDocument();
    expect(screen.getByLabelText("Additional roles")).toBeInTheDocument();
    expect(
      screen.getByText("Roles are defined in Settings → Roles & Access."),
    ).toBeInTheDocument();
  });

  it("disables an ungrantable role but keeps an already-assigned ungrantable role removable (b)", async () => {
    mockFetch();
    const user = userEvent.setup();
    // The member already HOLDS the ungrantable "Superuser" → must stay enabled.
    renderDialog({ id: "m1", name: "Ada", role: "MEMBER", workRoleIds: ["wr-super"] });

    await user.click(screen.getByLabelText("Additional roles"));

    // Grantable → enabled; built-in hint present on the label.
    const analyst = await screen.findByRole("option", { name: /Analyst/ });
    expect(analyst).not.toHaveAttribute("aria-disabled", "true");
    expect(analyst).toHaveTextContent("Built-in");

    // Ungrantable but ALREADY ASSIGNED → enabled (removable, de-escalation).
    const superuser = screen.getByRole("option", { name: /Superuser/ });
    expect(superuser).not.toHaveAttribute("aria-disabled", "true");

    // Ungrantable AND not assigned → disabled.
    const root = screen.getByRole("option", { name: /Root Access/ });
    expect(root).toHaveAttribute("aria-disabled", "true");
  });

  it("shows an OWNER's tier as static text and never PUTs the tier on save (c)", async () => {
    mockFetch();
    const user = userEvent.setup();
    const { onClose } = renderDialog({
      id: "m1",
      name: "Ada",
      role: "OWNER",
      workRoleIds: [],
    });

    expect(screen.getByText("Owner — transfer ownership to change")).toBeInTheDocument();
    expect(screen.queryByLabelText("Primary tier")).toBeNull();

    // Add a work-role so the roles PUT fires — proving the tier PUT is skipped,
    // not merely that nothing happened.
    await user.click(screen.getByLabelText("Additional roles"));
    await user.click(await screen.findByRole("option", { name: /Analyst/ }));
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // The work-roles PUT fired…
    expect(puts().some((c) => /\/members\/m1\/work-roles$/.test(c.url))).toBe(true);
    // …but the tier PUT never did.
    expect(puts().some((c) => /\/members\/m1$/.test(c.url))).toBe(false);
  });

  it("saves a changed tier then changed roles as two ordered PUTs with the right bodies (d)", async () => {
    mockFetch();
    const user = userEvent.setup();
    const { onClose } = renderDialog({
      id: "m1",
      name: "Ada",
      role: "MEMBER",
      workRoleIds: [],
    });

    // Change tier MEMBER → ADMIN.
    await user.click(screen.getByLabelText("Primary tier"));
    await user.click(await screen.findByRole("option", { name: "Admin" }));

    // Add the Analyst work-role.
    await user.click(screen.getByLabelText("Additional roles"));
    await user.click(await screen.findByRole("option", { name: /Analyst/ }));

    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    const p = puts();
    expect(p).toHaveLength(2);
    // Tier first.
    expect(p[0].url).toMatch(/\/members\/m1$/);
    expect(p[0].body).toEqual({ role: "ADMIN" });
    // Then roles.
    expect(p[1].url).toMatch(/\/members\/m1\/work-roles$/);
    expect(p[1].body).toEqual({ workRoleIds: ["wr-analyst"] });
    expect(refresh).toHaveBeenCalled();
  });

  it("shows 'Tier saved. Roles rejected: <server error>' and stays open on a roles 403 (e)", async () => {
    const denied = "You can't grant 'Superuser' — it exceeds your own permissions";
    mockFetch({ rolesStatus: 403, rolesError: denied });
    const user = userEvent.setup();
    const { onClose } = renderDialog({
      id: "m1",
      name: "Ada",
      role: "MEMBER",
      workRoleIds: [],
    });

    // Change the tier (succeeds) and add a role (403s).
    await user.click(screen.getByLabelText("Primary tier"));
    await user.click(await screen.findByRole("option", { name: "Admin" }));
    await user.click(screen.getByLabelText("Additional roles"));
    await user.click(await screen.findByRole("option", { name: /Analyst/ }));
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(
      await screen.findByText(`Tier saved. Roles rejected: ${denied}`),
    ).toBeInTheDocument();
    // The tier PUT landed; the dialog stays open (never closes) on the roles error.
    expect(puts().some((c) => /\/members\/m1$/.test(c.url) && (c.body as { role?: string }).role === "ADMIN")).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });
});
