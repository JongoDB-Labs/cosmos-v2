import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the two seams: the Integration lookup (toggle state) and the actual
// Graph post — the gating logic in between is what's under test.
const findFirst = vi.fn();
vi.mock("@/lib/db/client", () => ({
  prisma: { integration: { findFirst: (...a: unknown[]) => findFirst(...a) } },
}));
const postTeamsChannelMessage = vi.fn();
vi.mock("@/lib/integrations/teams", () => ({
  postTeamsChannelMessage: (...a: unknown[]) => postTeamsChannelMessage(...a),
}));

// The channel rule is its own module (channel-policy.db.test.ts drives it on a
// database); here it is a stub whose answers each test sets.
const policy = {
  project: vi.fn<(id: string) => Promise<object | null>>(async () => ({ id: "p1" })),
  chatChannel: vi.fn<(id: string) => Promise<object | null>>(async () => ({ projectId: null })),
  text: vi.fn((_p: string | null, t: string | null | undefined) => (t && !/\bCUI\b/.test(t) ? t : undefined)),
};
vi.mock("@/lib/integrations/channel-policy.server", () => ({ channelPolicy: async () => policy }));

import { teamsNotify, teamsEventEnabled, TEAMS_NOTIFY_DEFAULTS } from "./teams-notify";

const ABOUT = { projectIds: ["p1"] };

describe("teamsEventEnabled", () => {
  beforeEach(() => {
    findFirst.mockReset();
    postTeamsChannelMessage.mockReset();
  });

  it("is false when the org has no active Teams integration", async () => {
    findFirst.mockResolvedValue(null);
    expect(await teamsEventEnabled("org1", "itemCompleted")).toBe(false);
    // The query must scope to the provider AND ACTIVE status.
    expect(findFirst.mock.calls[0][0].where).toMatchObject({
      orgId: "org1",
      provider: "microsoft-teams-messaging",
      status: "ACTIVE",
    });
  });

  it("falls back to the defaults when no toggle is stored", async () => {
    findFirst.mockResolvedValue({ config: {} });
    expect(await teamsEventEnabled("org1", "itemCompleted")).toBe(
      TEAMS_NOTIFY_DEFAULTS.itemCompleted, // true
    );
    expect(await teamsEventEnabled("org1", "itemCreated")).toBe(
      TEAMS_NOTIFY_DEFAULTS.itemCreated, // false
    );
  });

  it("honors an explicit toggle over the default", async () => {
    findFirst.mockResolvedValue({
      config: { notify: { itemCompleted: false, itemCreated: true } },
    });
    expect(await teamsEventEnabled("org1", "itemCompleted")).toBe(false);
    expect(await teamsEventEnabled("org1", "itemCreated")).toBe(true);
  });
});

describe("teamsNotify", () => {
  beforeEach(() => {
    findFirst.mockReset();
    postTeamsChannelMessage.mockReset();
    policy.project.mockClear();
    policy.chatChannel.mockClear();
  });

  it("does not post about a project the channel rule refuses", async () => {
    findFirst.mockResolvedValue({ config: {} });
    policy.project.mockResolvedValueOnce(null);
    await teamsNotify("org1", "itemCompleted", "x", { projectIds: ["hidden"] });
    expect(policy.project).toHaveBeenCalledWith("hidden");
    expect(postTeamsChannelMessage).not.toHaveBeenCalled();
  });

  it("does not quote a chat channel the channel rule refuses", async () => {
    findFirst.mockResolvedValue({ config: { notify: { mentions: true } } });
    policy.chatChannel.mockResolvedValueOnce(null);
    await teamsNotify("org1", "mentions", "x", { chatChannelId: "dm" });
    expect(postTeamsChannelMessage).not.toHaveBeenCalled();
  });

  it("drops a post whose text still carries a marking", async () => {
    findFirst.mockResolvedValue({ config: {} });
    await teamsNotify("org1", "itemCompleted", "<b>A-1</b> CUI plan completed", ABOUT);
    expect(postTeamsChannelMessage).not.toHaveBeenCalled();
  });

  it("posts when the event is enabled", async () => {
    findFirst.mockResolvedValue({ config: { notify: { itemCreated: true } } });
    await teamsNotify("org1", "itemCreated", "<b>hi</b>", ABOUT);
    expect(postTeamsChannelMessage).toHaveBeenCalledWith("org1", { html: "<b>hi</b>" });
  });

  it("does not post when the toggle is off", async () => {
    findFirst.mockResolvedValue({ config: { notify: { itemCompleted: false } } });
    await teamsNotify("org1", "itemCompleted", "x", ABOUT);
    expect(postTeamsChannelMessage).not.toHaveBeenCalled();
  });

  it("does not post when the integration is missing or inactive", async () => {
    findFirst.mockResolvedValue(null);
    await teamsNotify("org1", "feedbackDelivered", "x", ABOUT);
    expect(postTeamsChannelMessage).not.toHaveBeenCalled();
  });

  it("swallows post failures (best-effort, never throws)", async () => {
    findFirst.mockResolvedValue({ config: {} });
    postTeamsChannelMessage.mockRejectedValue(new Error("graph down"));
    await expect(teamsNotify("org1", "itemCompleted", "x", ABOUT)).resolves.toBeUndefined();
  });

  it("swallows lookup failures too", async () => {
    findFirst.mockRejectedValue(new Error("db down"));
    await expect(teamsNotify("org1", "itemCompleted", "x", ABOUT)).resolves.toBeUndefined();
    expect(postTeamsChannelMessage).not.toHaveBeenCalled();
  });
});
