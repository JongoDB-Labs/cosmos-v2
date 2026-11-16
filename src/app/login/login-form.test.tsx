/**
 * The sign-in page.
 *
 * The request-an-account and forgot-password forms say "sent" only when the
 * request was taken. Both used to show the same confirmation whatever came
 * back, so a request the server never took still read as sent. Each error is
 * the same for every failure, so it says nothing about whether the org or the
 * address exists: the routes answer 200 either way, and only an outage, a
 * throttle or a refusal in front of them gets here.
 *
 * Every way of signing in lands on the page the visitor was sent here from
 * (`?next=`), checked by the shared return-address rule.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextRequest } from "next/server";

const nav = vi.hoisted(() => ({ search: "org=acme" }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(nav.search) }));
// Enrollment draws a QR code; jsdom has no canvas to draw it on.
vi.mock("qrcode", () => ({ toDataURL: async () => "data:image/png;base64,AA==" }));
// One test runs the real forgot-password route, on a stand-in database that
// knows no one, so the form is shown the route's own answer.
const db = vi.hoisted(() => ({
  user: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
  invitation: { findFirst: vi.fn(async () => null) },
}));
vi.mock("@/lib/db/client", () => ({ prisma: db }));

import { LoginForm } from "./login-form";

const SENT = /Your request has been sent/;
const FAILED = "We couldn't send your request. Try again in a minute.";

type Routes = Record<string, () => Promise<Response>>;

/**
 * The page's own probes answer as for an org that takes requests and has no
 * SSO; `routes` answers anything else by exact URL, and overrides the probes.
 */
function serveAll(routes: Routes) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const url = String(input);
    if (routes[url]) return routes[url]();
    if (url.startsWith("/api/auth/sso/")) return Response.json({ enabled: false, enforced: false, accountRequests: true });
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** As serveAll, with the account request itself answering `reply`. */
function serve(reply: () => Promise<Response>) {
  return serveAll({ "/api/auth/account-request": reply });
}

// Navigation is a write to window.location.href. This records it, resolved
// against the current address the way a browser resolves it.
const realLocation = window.location;
beforeEach(() => {
  let href = "http://localhost/login";
  const recording = {
    ...realLocation,
    get href() {
      return href;
    },
    set href(to: string) {
      href = new URL(to, href).href;
    },
  };
  Object.defineProperty(window, "location", { configurable: true, value: recording });
});

/** Where the page sent the browser: path, query and fragment. */
function wentTo(): string {
  const url = new URL(window.location.href);
  return `${url.pathname}${url.search}${url.hash}`;
}
afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
  nav.search = "org=acme";
});

async function sendRequest() {
  render(<LoginForm />);
  fireEvent.click(await screen.findByRole("button", { name: "Sign in with email & password" }));
  fireEvent.click(await screen.findByText("Request an account"));
  fireEvent.change(screen.getByPlaceholderText("you@company.com"), { target: { value: "new.person@example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "Send request" }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the sign-in page's account request", () => {
  it("shows the neutral confirmation when the request is taken", async () => {
    const fetchMock = serve(async () => Response.json({ ok: true }));
    await sendRequest();
    expect(await screen.findByText(SENT)).toBeTruthy();
    expect(screen.queryByText(FAILED)).toBeNull();
    // It did send what was typed, to the route.
    const [, init] = fetchMock.mock.calls.find(([u]) => String(u) === "/api/auth/account-request")!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ orgSlug: "acme", email: "new.person@example.test" });
  });

  it.each([401, 403, 429, 500, 503])("shows an error, not the confirmation, on a %i", async (status) => {
    serve(async () => Response.json({ error: "x" }, { status }));
    await sendRequest();
    expect(await screen.findByText(FAILED)).toBeTruthy();
    expect(screen.queryByText(SENT)).toBeNull();
    // Still on the form, so the visitor can try again.
    expect(screen.getByRole("button", { name: "Send request" })).toBeTruthy();
  });

  it("shows the same error when the request never reaches the server", async () => {
    serve(async () => {
      throw new TypeError("Failed to fetch");
    });
    await sendRequest();
    expect(await screen.findByText(FAILED)).toBeTruthy();
    expect(screen.queryByText(SENT)).toBeNull();
  });
});

const RESET_SENT = /If an account with that email exists/;
const RESET_FAILED = "We couldn't send a reset link. Try again in a minute.";

async function sendReset() {
  render(<LoginForm />);
  fireEvent.click(await screen.findByRole("button", { name: "Sign in with email & password" }));
  fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
  fireEvent.change(screen.getByPlaceholderText("you@company.com"), { target: { value: "someone@example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
}

describe("the sign-in page's forgot-password form", () => {
  it("shows the neutral confirmation when the request is taken", async () => {
    const fetchMock = serveAll({ "/api/auth/password/reset/request": async () => Response.json({ ok: true }) });
    await sendReset();
    expect(await screen.findByText(RESET_SENT)).toBeTruthy();
    expect(screen.queryByText(RESET_FAILED)).toBeNull();
    const [, init] = fetchMock.mock.calls.find(([u]) => String(u) === "/api/auth/password/reset/request")!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ email: "someone@example.test", orgSlug: "acme" });
  });

  it.each([403, 429, 500, 502, 503])("says it was not sent, and stays on the form, on a %i", async (status) => {
    serveAll({ "/api/auth/password/reset/request": async () => Response.json({ error: "x" }, { status }) });
    await sendReset();
    expect((await screen.findByRole("alert")).textContent).toBe(RESET_FAILED);
    expect(screen.queryByText(RESET_SENT)).toBeNull();
    expect(screen.getByRole("button", { name: "Send reset link" })).toBeTruthy();
  });

  it("says it was not sent when the address has asked too often", async () => {
    const { POST } = await import("@/app/api/auth/password/reset/request/route");
    const ask = (client: number) =>
      POST(
        new NextRequest("http://localhost/api/auth/password/reset/request", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": `192.0.2.${client}` },
          body: JSON.stringify({ email: "asked-often@example.test" }),
        }),
      );
    for (let client = 1; client <= 3; client++) expect((await ask(client)).status).toBe(200);
    const lookups = db.user.findFirst.mock.calls.length;
    // Positive control: the requests under the limit did look the address up.
    expect(lookups).toBe(3);
    const limited = await ask(4);
    expect(limited.status).toBe(429);
    // Answered before any lookup, so the answer can't depend on the account.
    expect(db.user.findFirst.mock.calls.length).toBe(lookups);

    const body = await limited.text();
    serveAll({ "/api/auth/password/reset/request": async () => new Response(body, { status: limited.status }) });
    await sendReset();
    expect((await screen.findByRole("alert")).textContent).toBe(RESET_FAILED);
    expect(screen.queryByText(RESET_SENT)).toBeNull();
  });

  it("says the same when the request never reaches the server", async () => {
    serveAll({
      "/api/auth/password/reset/request": async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await sendReset();
    expect((await screen.findByRole("alert")).textContent).toBe(RESET_FAILED);
    expect(screen.queryByText(RESET_SENT)).toBeNull();
  });
});

const DEEP = "/acme/issues?view=list&q=open";

/** Sign in with email and password; the routes answer the rest of the steps. */
async function signInWithPassword(routes: Routes) {
  serveAll(routes);
  render(<LoginForm />);
  fireEvent.click(await screen.findByRole("button", { name: "Sign in with email & password" }));
  fireEvent.change(screen.getByPlaceholderText("you@company.com"), { target: { value: "someone@example.test" } });
  fireEvent.change(screen.getByPlaceholderText("Password"), { target: { value: "correct horse battery" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

const landsOn = (path: string) => waitFor(() => expect(wentTo()).toBe(path));

describe("signing in lands on the page the visitor came from", () => {
  const ok = async () => Response.json({ ok: true });

  it("with a password", async () => {
    nav.search = `next=${encodeURIComponent(DEEP)}`;
    await signInWithPassword({ "/api/auth/password/login": ok });
    await landsOn(DEEP);
  });

  it("with a password and a two-factor code", async () => {
    nav.search = `next=${encodeURIComponent(DEEP)}`;
    await signInWithPassword({
      "/api/auth/password/login": async () => Response.json({ mfaRequired: true }),
      "/api/auth/password/mfa": ok,
    });
    fireEvent.change(await screen.findByPlaceholderText("123456"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await landsOn(DEEP);
  });

  it.each([
    ["after saving recovery codes", ["aaaa-bbbb", "cccc-dddd"]],
    ["when no recovery codes come back", undefined],
  ])("when first sign-in sets up two-factor, %s", async (_case, recoveryCodes) => {
    nav.search = `next=${encodeURIComponent(DEEP)}`;
    await signInWithPassword({
      "/api/auth/password/login": async () => Response.json({ next: "enroll_mfa" }),
      "/api/auth/password/first-login/mfa-setup": async () =>
        Response.json({ secret: "SECRET", otpauthUri: "otpauth://totp/x?secret=SECRET" }),
      "/api/auth/password/first-login/mfa-enroll": async () => Response.json({ ok: true, recoveryCodes }),
    });
    fireEvent.change(await screen.findByPlaceholderText("123456"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Enable & continue" }));
    if (recoveryCodes) fireEvent.click(await screen.findByRole("button", { name: /saved them/ }));
    await landsOn(DEEP);
  });

  it("lands on / when the address is not a page on this site", async () => {
    nav.search = `next=${encodeURIComponent("//elsewhere.example/acme")}`;
    await signInWithPassword({ "/api/auth/password/login": ok });
    await landsOn("/");
  });

  it("lands on / with no return address", async () => {
    nav.search = "";
    await signInWithPassword({ "/api/auth/password/login": ok });
    await landsOn("/");
  });
});

describe("the provider buttons carry the return address to the sign-in start", () => {
  const providers: Routes = {
    "/api/auth/microsoft/status": async () => Response.json({ configured: true }),
    "/api/auth/sso/acme/status": async () => Response.json({ enabled: true, enforced: false }),
  };
  const next = `next=${encodeURIComponent(DEEP)}`;

  it.each([
    ["Sign in with Google", "/api/auth/google"],
    ["Sign in with Microsoft", "/api/auth/microsoft"],
    ["Sign in with SSO", "/api/auth/sso/acme/login"],
  ])("%s", async (name, start) => {
    nav.search = `org=acme&${next}`;
    serveAll(providers);
    render(<LoginForm />);
    fireEvent.click(await screen.findByRole("button", { name }));
    expect(wentTo()).toBe(`${start}?${next}`);
  });

  it.each([
    ["Sign in with Google", "/api/auth/google"],
    ["Sign in with Microsoft", "/api/auth/microsoft"],
    ["Sign in with SSO", "/api/auth/sso/acme/login"],
  ])("%s, with nothing to carry", async (name, start) => {
    nav.search = "org=acme";
    serveAll(providers);
    render(<LoginForm />);
    fireEvent.click(await screen.findByRole("button", { name }));
    expect(wentTo()).toBe(start);
  });
});
