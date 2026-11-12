import { describe, it, expect } from "vitest";
import {
  chatDrawerHref,
  chatDrawerTargetFromParams,
  chatDrawerTargetFromUrl,
  legacyChatPath,
  MAX_DM_PEOPLE,
} from "./drawer-link";

const q = (s: string) => new URLSearchParams(s);

describe("chatDrawerHref", () => {
  it("adds the conversation to a page, keeping the page's own query", () => {
    expect(chatDrawerHref("/acme/projects?view=list", { channelId: "c1" })).toBe(
      "/acme/projects?view=list&chat=c1",
    );
  });

  it("names a message only alongside its conversation", () => {
    expect(chatDrawerHref("/acme", { channelId: "c1", messageId: "m1" })).toBe("/acme?chat=c1&chatMsg=m1");
    expect(chatDrawerHref("/acme", { messageId: "m1" })).toBe("/acme?chat=");
  });

  it("opens the conversation list when no conversation is named", () => {
    expect(chatDrawerHref("/acme", {})).toBe("/acme?chat=");
  });

  it("starts a DM with people instead of naming a conversation", () => {
    expect(chatDrawerHref("/acme", { withUserIds: ["u1", "u2"] })).toBe("/acme?chatWith=u1%2Cu2");
  });

  it("replaces an earlier chat target and drops the hash", () => {
    expect(chatDrawerHref("/acme/x?chat=old&chatMsg=m0&a=1#msg-m0", { channelId: "new" })).toBe(
      "/acme/x?a=1&chat=new",
    );
  });
});

describe("chatDrawerTargetFromParams", () => {
  it("reads nothing from a query with no chat in it", () => {
    expect(chatDrawerTargetFromParams(q("view=list"))).toBeNull();
  });

  it("reads a conversation, and a message in it", () => {
    expect(chatDrawerTargetFromParams(q("chat=c1"))).toEqual({ channelId: "c1" });
    expect(chatDrawerTargetFromParams(q("chat=c1&chatMsg=m1"))).toEqual({ channelId: "c1", messageId: "m1" });
  });

  it("reads an old link's #msg- anchor when chatMsg is absent", () => {
    expect(chatDrawerTargetFromParams(q("chat=c1"), "#msg-m7")).toEqual({ channelId: "c1", messageId: "m7" });
    expect(chatDrawerTargetFromParams(q("chat=c1&chatMsg=m1"), "#msg-m7")).toEqual({
      channelId: "c1",
      messageId: "m1",
    });
    // Any other anchor is the page's own business.
    expect(chatDrawerTargetFromParams(q("chat=c1"), "#section-2")).toEqual({ channelId: "c1" });
  });

  it("reads an empty chat as the conversation list", () => {
    expect(chatDrawerTargetFromParams(q("chat="))).toEqual({});
    expect(chatDrawerTargetFromParams(q("chat"))).toEqual({});
  });

  it("reads people to DM, de-duplicated and capped at the route's limit", () => {
    expect(chatDrawerTargetFromParams(q("chatWith=u1,u2,u1"))).toEqual({ withUserIds: ["u1", "u2"] });
    const many = Array.from({ length: 12 }, (_, i) => `u${i}`).join(",");
    expect(chatDrawerTargetFromParams(q(`chatWith=${many}`))?.withUserIds).toHaveLength(MAX_DM_PEOPLE);
    expect(chatDrawerTargetFromParams(q("chatWith=,"))).toEqual({});
  });

  it("round-trips everything chatDrawerHref builds", () => {
    for (const t of [{}, { channelId: "c1" }, { channelId: "c1", messageId: "m1" }, { withUserIds: ["u1"] }]) {
      const href = chatDrawerHref("/acme/x?a=1", t);
      expect(chatDrawerTargetFromParams(new URL(href, "http://h").searchParams)).toEqual(t);
    }
  });
});

describe("legacyChatPath", () => {
  it("recognises the old page and its conversations", () => {
    expect(legacyChatPath("/acme/chat")).toEqual({ orgSlug: "acme" });
    expect(legacyChatPath("/acme/chat/")).toEqual({ orgSlug: "acme" });
    expect(legacyChatPath("/acme/chat/c1")).toEqual({ orgSlug: "acme", channelId: "c1" });
  });

  it("leaves the API and every other page alone", () => {
    expect(legacyChatPath("/api/chat")).toBeNull();
    expect(legacyChatPath("/api/v1/orgs/o1/chat/channels")).toBeNull();
    expect(legacyChatPath("/acme/chat/c1/extra")).toBeNull();
    expect(legacyChatPath("/acme/chatter")).toBeNull();
    expect(legacyChatPath("/acme/projects")).toBeNull();
  });
});

describe("chatDrawerTargetFromUrl — what the bell, the inbox and Mentioned in open in place", () => {
  it("reads the drawer form a notification now stores", () => {
    expect(chatDrawerTargetFromUrl("/acme?chat=c1&chatMsg=m1")).toEqual({ channelId: "c1", messageId: "m1" });
  });

  it("reads the old page a notification sent before the drawer stores", () => {
    expect(chatDrawerTargetFromUrl("/acme/chat/c1#msg-m1")).toEqual({ channelId: "c1", messageId: "m1" });
    expect(chatDrawerTargetFromUrl("/acme/chat/c1")).toEqual({ channelId: "c1" });
    expect(chatDrawerTargetFromUrl("/acme/chat")).toEqual({});
  });

  it("is null for any other link, and for someone else's site", () => {
    expect(chatDrawerTargetFromUrl("/acme/work-items?item=w1")).toBeNull();
    expect(chatDrawerTargetFromUrl("https://example.com/acme/chat/c1")).toBeNull();
    expect(chatDrawerTargetFromUrl("//example.com/acme/chat/c1")).toBeNull();
    expect(chatDrawerTargetFromUrl(null)).toBeNull();
    expect(chatDrawerTargetFromUrl("")).toBeNull();
  });
});
