/**
 * The sign-in page's request-an-account form says "sent" only when the request
 * was taken. It used to show the same confirmation whatever came back, so a
 * request the server never stored still read as sent.
 *
 * The error is the same for every failure, so it says nothing about whether the
 * org or the address exists: the route answers 200 either way, and only an
 * outage, a throttle or a refusal in front of it gets here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams("org=acme") }));

import { LoginForm } from "./login-form";

const SENT = /Your request has been sent/;
const FAILED = "We couldn't send your request. Try again in a minute.";

/** The page's own probes answer as for an org that takes requests; the request itself answers `reply`. */
function serve(reply: () => Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const url = String(input);
    if (url.startsWith("/api/auth/sso/")) return Response.json({ enabled: false, enforced: false, accountRequests: true });
    if (url === "/api/auth/account-request") return reply();
    return Response.json({}, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

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
