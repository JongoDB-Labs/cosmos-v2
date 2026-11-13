import { describe, expect, it } from "vitest";
import { RolePermissions } from "@/lib/rbac/permissions";
import { streamDecision, type StreamAudience } from "./stream-access";
import { topics } from "./topics";

const audience: StreamAudience = {
  readable: new Set(["open"]),
  known: new Set(["open", "hidden"]),
  chat: true,
  channels: new Set(["mine"]),
  permissions: RolePermissions.MEMBER,
};
const noChat: StreamAudience = { ...audience, chat: false };
const guest: StreamAudience = { ...audience, permissions: RolePermissions.GUEST };

const org = (type: string, data: unknown = {}) => ({ topic: topics.org("o"), type, data });
const own = (type: string, data: unknown = {}) => ({ topic: topics.user("u"), type, data });
const channel = (id: string, type: string, data: unknown = {}) => ({ topic: topics.channel(id), type, data });

describe("streamDecision", () => {
  it("sends an event about a readable project and drops one about a hidden project", () => {
    expect(streamDecision(org("work-item.created", { projectId: "open" }), audience)).toBe("send");
    expect(streamDecision(org("work-item.created", { projectId: "hidden" }), audience)).toBe("drop");
  });

  it("asks for a recompute about a project it has never heard of", () => {
    expect(streamDecision(org("work-item.created", { projectId: "new" }), audience)).toBe("refresh");
  });

  it("drops a project-bound event with no project, and sends an org-wide one", () => {
    expect(streamDecision(org("work-item.updated", { ids: ["a"] }), audience)).toBe("drop");
    expect(streamDecision(org("ceremony.changed", { ceremonyId: "c" }), audience)).toBe("drop");
    expect(streamDecision(org("feedback.delivered", { feedbackId: "f" }), audience)).toBe("send");
  });

  it("drops an event type nobody classified, with or without a project", () => {
    // Fail closed: a new event is heard by no one until it says who may hear it.
    expect(streamDecision(org("plugin.thing.changed", { eventId: "e" }), audience)).toBe("drop");
    expect(streamDecision(org("plugin.thing.changed", { projectId: "open" }), audience)).toBe("drop");
    expect(streamDecision(org("hello", {}), audience)).toBe("drop");
  });

  it("sends a plugin's classified events only to someone holding the bit its reads require", () => {
    expect(streamDecision(org("pi_planning.board.changed", { eventId: "e" }), audience)).toBe("send");
    expect(streamDecision(org("pi_planning.board.changed", { eventId: "e" }), guest)).toBe("drop");
    // One that names a project is checked against it as well.
    expect(streamDecision(org("pi_planning.board.changed", { eventId: "e", projectId: "hidden" }), audience)).toBe("drop");
    expect(streamDecision(org("pi_planning.board.changed", { eventId: "e", projectId: "open" }), audience)).toBe("send");
  });

  it("sends chat only with CHAT_USE, presence included", () => {
    expect(streamDecision(channel("mine", "chat.message.created"), audience)).toBe("send");
    expect(streamDecision(channel("mine", "chat.message.created"), noChat)).toBe("drop");
    expect(streamDecision(own("chat.unread.bumped"), noChat)).toBe("drop");
    expect(streamDecision(org("chat.presence.changed", { userId: "u" }), noChat)).toBe("drop");
    expect(streamDecision(org("chat.presence.changed", { userId: "u" }), audience)).toBe("send");
  });

  it("sends a channel's traffic only while the subscriber is in that channel", () => {
    expect(streamDecision(channel("theirs", "chat.message.created", { channelId: "theirs" }), audience)).toBe("drop");
    // By topic, not payload: a reaction names only its message.
    expect(streamDecision(channel("theirs", "chat.reaction.added", { messageId: "m" }), audience)).toBe("drop");
    expect(streamDecision(channel("mine", "chat.reaction.added", { messageId: "m" }), audience)).toBe("send");
    // Their own topic still tells them they left.
    expect(streamDecision(own("chat.channel.left", { channelId: "theirs" }), audience)).toBe("send");
  });

  it("sends a notification only from the subscriber's own topic", () => {
    expect(streamDecision(own("notification.created", { id: "n" }), audience)).toBe("send");
    expect(streamDecision(org("notification.created", { id: "n" }), audience)).toBe("drop");
  });

  it("drops an event from a topic it cannot read", () => {
    expect(streamDecision({ topic: "nonsense", type: "settings.updated", data: {} }, audience)).toBe("drop");
  });
});
