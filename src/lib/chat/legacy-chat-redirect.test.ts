// The old full-page chat redirects into the drawer, on the same conversation.
// Tested twice: the pure rule, and the real proxy that serves it, because a
// correct rule nobody calls protects nothing.
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

const findSession = vi.hoisted(() => vi.fn(async () => null));
vi.mock("@/lib/db/client", () => ({ prisma: { session: { findUnique: findSession } } }));
vi.mock("@/lib/cutover/freeze", () => ({ isMutatingMethod: () => false, isPathOrgFrozen: async () => false }));

import { legacyChatRedirect } from "./legacy-chat-redirect";
import { chatDrawerTargetFromParams } from "./drawer-link";
import { proxy } from "@/proxy";

const HOST = "cosmos.example.dev";
const go = (pathname: string, referer: string | null = null, method = "GET") =>
  legacyChatRedirect({ method, pathname, referer, host: HOST });

describe("legacyChatRedirect", () => {
  it("keeps the conversation and returns to the page the person came from", () => {
    expect(go("/acme/chat/c1", `https://${HOST}/acme/projects?view=list`)).toBe(
      "/acme/projects?view=list&chat=c1",
    );
  });

  it("goes to the org home when there is no page to return to", () => {
    expect(go("/acme/chat/c1")).toBe("/acme?chat=c1");
  });

  it("opens the conversation list for the old chat landing page", () => {
    expect(go("/acme/chat")).toBe("/acme?chat=");
    expect(go("/acme/chat", `https://${HOST}/acme/notes`)).toBe("/acme/notes?chat=");
  });

  it("never returns to another site, another org, or the chat page itself", () => {
    expect(go("/acme/chat/c1", "https://mail.example.com/inbox/42")).toBe("/acme?chat=c1");
    expect(go("/acme/chat/c1", `https://${HOST}/other-org/projects`)).toBe("/acme?chat=c1");
    expect(go("/acme/chat/c1", `https://${HOST}/acme/chat/c0`)).toBe("/acme?chat=c1");
    expect(go("/acme/chat/c1", `https://${HOST}/login`)).toBe("/acme?chat=c1");
    expect(go("/acme/chat/c1", "not a url")).toBe("/acme?chat=c1");
  });

  it("replaces an earlier chat target on the page it returns to", () => {
    expect(go("/acme/chat/c1", `https://${HOST}/acme/projects?chat=c0&chatMsg=m0`)).toBe(
      "/acme/projects?chat=c1",
    );
  });

  it("matches a forwarded host without a port to a Referer with one", () => {
    expect(
      legacyChatRedirect({ method: "GET", pathname: "/acme/chat/c1", referer: "http://localhost:3116/acme/okrs", host: "localhost" }),
    ).toBe("/acme/okrs?chat=c1");
  });

  it("leaves every other address and method alone", () => {
    expect(go("/acme/projects")).toBeNull();
    expect(go("/api/v1/orgs/o1/chat/channels")).toBeNull();
    expect(go("/acme/chat/c1", null, "POST")).toBeNull();
    expect(go("/acme/chat/c1", null, "HEAD")).toBe("/acme?chat=c1");
  });

  it("lands on a URL the drawer opens on the same conversation", () => {
    const to = new URL(go("/acme/chat/c1", `https://${HOST}/acme/okrs`)!, `https://${HOST}`);
    // The old link's #msg- anchor survives a redirect in the browser.
    expect(chatDrawerTargetFromParams(to.searchParams, "#msg-m1")).toEqual({ channelId: "c1", messageId: "m1" });
  });
});

describe("proxy: the old chat page", () => {
  const req = (path: string, headers: Record<string, string> = {}) =>
    new NextRequest(new URL(path, "http://cosmos:3000"), {
      headers: { host: "cosmos:3000", "x-forwarded-host": HOST, ...headers },
    });

  it("redirects a conversation to the previous page with the drawer open on it", async () => {
    findSession.mockClear();
    const res = await proxy(req("/acme/chat/c1", { referer: `https://${HOST}/acme/work-items?view=board` }));
    expect(res.status).toBe(307);
    const to = new URL(res.headers.get("location")!);
    expect(to.pathname).toBe("/acme/work-items");
    expect(to.searchParams.get("view")).toBe("board");
    expect(to.searchParams.get("chat")).toBe("c1");
    // Before the session check: it costs no database read.
    expect(findSession).not.toHaveBeenCalled();
  });

  it("redirects the old landing page to the org home with the drawer open", async () => {
    const res = await proxy(req("/acme/chat"));
    expect(res.status).toBe(307);
    const to = new URL(res.headers.get("location")!);
    expect(to.pathname).toBe("/acme");
    expect(to.searchParams.get("chat")).toBe("");
  });

  it("control: any other page still goes through the sign-in check", async () => {
    const res = await proxy(req("/acme/projects"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });

  it("leaves the chat API to its routes", async () => {
    const res = await proxy(req("/api/v1/orgs/o1/chat/channels", { authorization: "Bearer cosmos_x" }));
    expect(res.headers.get("location")).toBeNull();
  });
});
