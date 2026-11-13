// @vitest-environment jsdom
//
// A chat link on any page opens the docked Chat drawer on that conversation.
//
// The full-page chat is gone, so a notification, a "Mentioned in" backlink or
// an old bookmark (via the proxy's redirect) all arrive as `?chat=<id>` on some
// page. This renders the REAL provider, mount, drawer and Chat panel; only the
// data hooks and the heavy chat views are stubbed, so what is asserted is which
// conversation the drawer actually shows.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { StrictMode } from "react";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
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

const channels = [
  { id: "c1", kind: "CHANNEL", name: "general", otherParticipants: [] },
  { id: "c2", kind: "CHANNEL", name: "random", otherParticipants: [] },
  { id: "dm-1", kind: "DM", name: null, otherParticipants: [{ id: "u9", displayName: "Bob" }] },
];
vi.mock("@/hooks/use-chat-channels", () => ({ useChatChannels: () => ({ data: channels }) }));
vi.mock("@/components/chat/chat-sidebar", () => ({
  ChatSidebar: () => <div data-testid="chat-sidebar" />,
}));
vi.mock("@/components/chat/channel-view", () => ({
  ChannelView: (p: { channelId: string; focusMessageId?: string }) => (
    <div data-testid="channel-view" data-channel={p.channelId} data-focus={p.focusMessageId ?? ""} />
  ),
}));

import { PermissionsProvider } from "@/components/providers/permissions-provider";
import { DrawerProvider } from "./drawer-provider";
import { DockedDrawer } from "./docked-drawer";
import { ChatLinkMount } from "./chat-link-mount";

function app() {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {/* A role that holds CHAT_USE: the drawer offers chat only then. */}
      <PermissionsProvider orgs={[{ id: "org-1", slug: "acme", role: "MEMBER" }]}>
        <DrawerProvider>
          <ChatLinkMount />
          <DockedDrawer orgId="org-1" orgSlug="acme" userId="u1" />
        </DrawerProvider>
      </PermissionsProvider>
    </QueryClientProvider>
  );
}

let replaceState: ReturnType<typeof vi.spyOn>;
function visit(url: string) {
  window.history.replaceState(null, "", url);
  replaceState = vi.spyOn(window.history, "replaceState");
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("a ?chat= link opens the Chat drawer on that conversation", () => {
  it("opens the named conversation, at the old link's message, and cleans the address", async () => {
    visit("/acme/projects?view=list&chat=c2#msg-m9");
    render(app());

    const view = await screen.findByTestId("channel-view");
    expect(view.dataset.channel).toBe("c2");
    expect(view.dataset.focus).toBe("m9");
    expect(screen.getByRole("complementary", { name: "chat drawer" })).toBeTruthy();

    // The page keeps its own query; the chat parameters and anchor are gone.
    expect(replaceState).toHaveBeenCalledWith(null, "", "/acme/projects?view=list");
    expect(window.location.search).toBe("?view=list");
    expect(window.location.hash).toBe("");
  });

  it("control: with no chat parameter the drawer stays shut", () => {
    visit("/acme/projects?view=list");
    render(app());
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("opens the conversation list for an empty ?chat=", async () => {
    visit("/acme?chat=");
    render(app());
    expect(await screen.findByTestId("chat-sidebar")).toBeTruthy();
    expect(screen.queryByTestId("channel-view")).toBeNull();
  });

  it("moves a drawer that is already open to the next link's conversation", async () => {
    visit("/acme/okrs?chat=c1");
    const { rerender } = render(app());
    expect((await screen.findByTestId("channel-view")).dataset.channel).toBe("c1");

    window.history.replaceState(null, "", "/acme/okrs?chat=c2&chatMsg=m2");
    rerender(app());
    await waitFor(() => expect(screen.getByTestId("channel-view").dataset.channel).toBe("c2"));
    expect(screen.getByTestId("channel-view").dataset.focus).toBe("m2");
  });

  it("says so, on the list, when the conversation is gone or not yours", async () => {
    visit("/acme?chat=not-mine");
    render(app());
    expect(
      await screen.findByText("That conversation no longer exists, or you don't have access to it."),
    ).toBeTruthy();
    expect(screen.getByTestId("chat-sidebar")).toBeTruthy();
    expect(screen.queryByTestId("channel-view")).toBeNull();
  });

  it("starts a DM from ?chatWith= once, even under StrictMode, and opens it", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { channelId: "dm-1" } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    visit("/acme/team?chatWith=u9");
    render(<StrictMode>{app()}</StrictMode>);

    await waitFor(() => expect(screen.getByTestId("channel-view").dataset.channel).toBe("dm-1"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/orgs/org-1/chat/dms");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ userIds: ["u9"] });
    expect(window.location.search).toBe("");
  });

  it("says why when the DM can't be started", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({ error: "user_not_in_org" }) })),
    );
    visit("/acme?chatWith=u-gone");
    render(app());
    expect(await screen.findByText(/Couldn't start that conversation/)).toBeTruthy();
    expect(screen.queryByTestId("channel-view")).toBeNull();
  });
});
