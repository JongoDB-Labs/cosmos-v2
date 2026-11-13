// @vitest-environment jsdom
//
// The drawer offered a Chat tab to everyone, so a VIEWER (no CHAT_USE, which
// every chat route requires) opened it onto "Couldn't load this. Check your
// connection", an error about a network that was fine. The tab now follows the
// topbar's Chat gate, and a refusal from the server reads as what it is.
// Renders the real provider, drawer, Chat panel and channel hook; only fetch
// and the heavy chat views are stubbed.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { useEffect } from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
  usePathname: () => window.location.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/lib/hooks/use-media-query", () => ({ useMediaQuery: () => true }));
vi.mock("@/components/assistant/assistant-panel", () => ({ AssistantPanel: () => null }));
vi.mock("./panels/notes-panel", () => ({ NotesPanel: () => null }));
vi.mock("./panels/feedback-panel", () => ({ FeedbackPanel: () => null }));
vi.mock("./panels/meetings-panel", () => ({ MeetingsPanel: () => null }));
vi.mock("@/components/chat/channel-view", () => ({ ChannelView: () => <div data-testid="channel-view" /> }));

import { PermissionsProvider } from "@/components/providers/permissions-provider";
import { DrawerProvider, useDrawers, type DrawerTool } from "./drawer-provider";
import { DockedDrawer } from "./docked-drawer";

function Open({ tool }: { tool: DrawerTool }) {
  const { open } = useDrawers();
  useEffect(() => open(tool), [open, tool]);
  return null;
}

function app(role: string, tool: DrawerTool) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PermissionsProvider orgs={[{ id: "org-1", slug: "acme", role }]}>
        <DrawerProvider>
          <Open tool={tool} />
          <DockedDrawer orgId="org-1" orgSlug="acme" userId="u1" />
        </DrawerProvider>
      </PermissionsProvider>
    </QueryClientProvider>
  );
}

/** The channel list answers `status`; anything else the sidebar asks for is an empty list. */
const respond = (status: number, body: unknown) =>
  vi.fn(async (url: string) => {
    const [s, b] = String(url).endsWith("/chat/channels") ? [status, body] : [200, []];
    return new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  });

beforeEach(() => {
  window.history.replaceState(null, "", "/acme/projects");
  // Presence subscribes to the event stream.
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener() {}
      removeEventListener() {}
      close() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("the drawer's Chat tab", () => {
  it("is not offered to a role without CHAT_USE", async () => {
    vi.stubGlobal("fetch", respond(200, { channels: [] }));
    render(app("VIEWER", "assistant"));
    await screen.findByRole("complementary", { name: "assistant drawer" });
    expect(screen.getByRole("button", { name: "Assistant" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Chat" })).toBeNull();
  });

  it("is offered to a role with it (positive control)", async () => {
    vi.stubGlobal("fetch", respond(200, { channels: [] }));
    render(app("MEMBER", "assistant"));
    await screen.findByRole("complementary", { name: "assistant drawer" });
    expect(screen.getByRole("button", { name: "Chat" })).toBeTruthy();
  });

  it("opened anyway (a chat link), says there is no access and asks the server nothing", async () => {
    const fetch = respond(200, { channels: [] });
    vi.stubGlobal("fetch", fetch);
    render(app("VIEWER", "chat"));
    expect(await screen.findByText("You don't have access to chat")).toBeTruthy();
    expect(screen.queryByText(/check your connection/i)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says there is no access, not a connection problem, when the server refuses", async () => {
    // The role says chat, the member's own permissions do not.
    vi.stubGlobal("fetch", respond(403, "Forbidden"));
    render(app("MEMBER", "chat"));
    expect(await screen.findByText("You don't have access to chat")).toBeTruthy();
    expect(screen.queryByText(/check your connection/i)).toBeNull();
  });

  it("still reports a real load failure as one", async () => {
    vi.stubGlobal("fetch", respond(500, { error: "boom" }));
    render(app("MEMBER", "chat"));
    // After its one retry, as before.
    expect(await screen.findByText(/check your connection/i, undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText("You don't have access to chat")).toBeNull();
  });
});
