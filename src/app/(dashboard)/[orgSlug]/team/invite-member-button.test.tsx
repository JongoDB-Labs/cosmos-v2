// @vitest-environment jsdom
//
// The invite dialog offered Admin and Billing admin to everyone who could open
// it, though the server refuses a role beyond the inviter's own
// (`assertCanGrantOrgRole`): a member who manages members through a work role
// picked Admin and got a 403. It now offers the roles the server says the
// inviter may grant (`grantableOrgRoles`), and defaults to one of them.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

beforeAll(() => {
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
      // @ts-expect-error — no-op pointer-capture stubs for jsdom
      Element.prototype[m] = () => {};
    }
  }
});

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import { InviteMemberButton } from "./invite-member-button";

let posted: unknown[] = [];
function mockFetch() {
  posted = [];
  global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (String(url).endsWith("/invitations") && method === "POST") {
      const body = JSON.parse(String(init?.body));
      posted.push(body);
      return new Response(
        JSON.stringify({
          invitation: { id: "i1", email: body.email, role: body.role },
          acceptUrl: "http://localhost/invite/x",
          emailSent: true,
          emailError: null,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }
    // The work-role list.
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

async function openDialog(grantableRoles: string[]) {
  mockFetch();
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <InviteMemberButton orgId="org-1" grantableRoles={grantableRoles} />
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole("button", { name: /invite member/i }));
  await screen.findByText(/invite a teammate/i);
  return user;
}

async function roleOptions(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText("Role"));
  const options = await screen.findAllByRole("option");
  return options.map((o) => o.textContent?.trim() ?? "");
}

afterEach(cleanup);

describe("InviteMemberButton offers only the roles the inviter may grant", () => {
  it("offers a member who manages members no Admin and no Billing admin", async () => {
    const user = await openDialog(["MEMBER", "VIEWER", "GUEST"]);
    const labels = await roleOptions(user);
    expect(labels).toEqual([
      "Guest — comment on items only",
      "Viewer — read-only access",
      "Member — standard access",
    ]);
  });

  it("offers Admin and Billing admin to an owner, and never Owner itself", async () => {
    const user = await openDialog(["OWNER", "ADMIN", "BILLING_ADMIN", "MEMBER", "VIEWER", "GUEST"]);
    const labels = await roleOptions(user);
    expect(labels).toContain("Admin — manage the whole org");
    expect(labels).toContain("Billing admin — finance & billing");
    expect(labels.some((l) => /owner/i.test(l))).toBe(false);
  });

  it("defaults to a role the inviter may give, and sends it", async () => {
    const user = await openDialog(["VIEWER"]);
    await user.type(screen.getByLabelText(/email address/i), "new@example.com");
    await user.click(screen.getByRole("button", { name: /send invitation/i }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ email: "new@example.com", role: "VIEWER" });
  });

  it("keeps Member as the default when it may be given", async () => {
    const user = await openDialog(["MEMBER", "VIEWER", "GUEST"]);
    await user.type(screen.getByLabelText(/email address/i), "m@example.com");
    await user.click(screen.getByRole("button", { name: /send invitation/i }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ role: "MEMBER" });
  });
});
