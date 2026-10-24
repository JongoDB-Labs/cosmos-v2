import { describe, expect, it } from "vitest";
import {
  canSeeChannelGiven,
  canPostToChannelGiven,
  canManageChannelGiven,
  canDeleteMessageGiven,
} from "./access";

const publicChan = { kind: "CHANNEL" as const, isPrivate: false, isGeneral: false, orgId: "o1" };
const privateChan = { kind: "CHANNEL" as const, isPrivate: true,  isGeneral: false, orgId: "o1" };
const dmChan     = { kind: "DM"      as const, isPrivate: true,  isGeneral: false, orgId: "o1" };
const member     = { role: "MEMBER"  as const };
const admin      = { role: "ADMIN"   as const };

describe("canSeeChannelGiven", () => {
  it("org member can see any public channel in their org", () => {
    expect(canSeeChannelGiven({ channel: publicChan, member: null, viewerOrgId: "o1", orgRole: "MEMBER" })).toBe(true);
  });
  it("non-member cannot see private channel", () => {
    expect(canSeeChannelGiven({ channel: privateChan, member: null, viewerOrgId: "o1", orgRole: "MEMBER" })).toBe(false);
  });
  it("private channel member can see it", () => {
    expect(canSeeChannelGiven({ channel: privateChan, member, viewerOrgId: "o1", orgRole: "MEMBER" })).toBe(true);
  });
  it("cross-org is always false", () => {
    expect(canSeeChannelGiven({ channel: publicChan, member: null, viewerOrgId: "o2", orgRole: "MEMBER" })).toBe(false);
  });
  it("DM is only visible to its members", () => {
    expect(canSeeChannelGiven({ channel: dmChan, member: null, viewerOrgId: "o1", orgRole: "MEMBER" })).toBe(false);
    expect(canSeeChannelGiven({ channel: dmChan, member, viewerOrgId: "o1", orgRole: "MEMBER" })).toBe(true);
  });
});

describe("canPostToChannelGiven", () => {
  it("requires membership", () => {
    expect(canPostToChannelGiven({ channel: publicChan, member: null, viewerOrgId: "o1", orgRole: "MEMBER" })).toBe(false);
    expect(canPostToChannelGiven({ channel: publicChan, member, viewerOrgId: "o1", orgRole: "MEMBER" })).toBe(true);
  });
  it("cross-org returns false even if a (stale) membership row is provided", () => {
    expect(canPostToChannelGiven({ channel: publicChan, member, viewerOrgId: "o2", orgRole: "MEMBER" })).toBe(false);
  });
});

describe("canManageChannelGiven", () => {
  it("plain channel member cannot manage", () => {
    expect(canManageChannelGiven({ channel: publicChan, member, viewerOrgId: "o1", orgRole: "MEMBER", roleCounts: true })).toBe(false);
  });
  it("channel admin can manage", () => {
    expect(canManageChannelGiven({ channel: publicChan, member: admin, viewerOrgId: "o1", orgRole: "MEMBER", roleCounts: true })).toBe(true);
  });
  it("org admin can manage any channel in their org", () => {
    expect(canManageChannelGiven({ channel: publicChan, member: null, viewerOrgId: "o1", orgRole: "ADMIN", roleCounts: true })).toBe(true);
  });
  it("org owner can manage any channel in their org", () => {
    expect(canManageChannelGiven({ channel: publicChan, member: null, viewerOrgId: "o1", orgRole: "OWNER", roleCounts: true })).toBe(true);
  });
  it("cross-org false even for org admin", () => {
    expect(canManageChannelGiven({ channel: publicChan, member: admin, viewerOrgId: "o2", orgRole: "ADMIN", roleCounts: true })).toBe(false);
  });
});

describe("canDeleteMessageGiven", () => {
  it("author can delete own message", () => {
    expect(canDeleteMessageGiven({ authorId: "u1", viewerId: "u1", channelMember: member, orgRole: "MEMBER", roleCounts: true })).toBe(true);
  });
  it("channel admin can delete others' messages", () => {
    expect(canDeleteMessageGiven({ authorId: "u1", viewerId: "u2", channelMember: admin, orgRole: "MEMBER", roleCounts: true })).toBe(true);
  });
  it("org admin can delete others' messages", () => {
    expect(canDeleteMessageGiven({ authorId: "u1", viewerId: "u2", channelMember: null, orgRole: "ADMIN", roleCounts: true })).toBe(true);
  });
  it("plain member cannot delete others'", () => {
    expect(canDeleteMessageGiven({ authorId: "u1", viewerId: "u2", channelMember: member, orgRole: "MEMBER", roleCounts: true })).toBe(false);
  });
  it("non-channel-member with no org-admin role cannot delete", () => {
    expect(canDeleteMessageGiven({ authorId: "u1", viewerId: "u2", channelMember: null, orgRole: "MEMBER", roleCounts: true })).toBe(false);
  });
});

// An API key whose scopes don't grant CHAT_USE acts by neither role: not the org
// role, and not channel ADMIN, which whoever created the channel holds.
describe("when the actor's roles don't count (an API key)", () => {
  it("a channel ADMIN can't manage the channel", () => {
    expect(canManageChannelGiven({ channel: publicChan, member: admin, viewerOrgId: "o1", orgRole: "MEMBER", roleCounts: false })).toBe(false);
  });
  it("an org OWNER can't either", () => {
    expect(canManageChannelGiven({ channel: publicChan, member: null, viewerOrgId: "o1", orgRole: "OWNER", roleCounts: false })).toBe(false);
  });
  it("a channel ADMIN or org ADMIN can't delete someone else's message", () => {
    expect(canDeleteMessageGiven({ authorId: "u1", viewerId: "u2", channelMember: admin, orgRole: "MEMBER", roleCounts: false })).toBe(false);
    expect(canDeleteMessageGiven({ authorId: "u1", viewerId: "u2", channelMember: null, orgRole: "ADMIN", roleCounts: false })).toBe(false);
  });
  it("but still deletes its own", () => {
    expect(canDeleteMessageGiven({ authorId: "u1", viewerId: "u1", channelMember: member, orgRole: "MEMBER", roleCounts: false })).toBe(true);
  });
});
