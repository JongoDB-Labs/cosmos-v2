// @vitest-environment node
//
// Both status endpoints used to answer `connected: true` for a row whose token
// was past its expiry and could no longer be refreshed, so Settings showed a
// healthy connection while every agent request 401'd. `expired` reports it.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma, getClaudeTokenCore, fetchAccountEmail } = vi.hoisted(() => ({
  prisma: {
    userAiSettings: { findUnique: vi.fn() },
    orgAiSettings: { findUnique: vi.fn() },
  },
  getClaudeTokenCore: vi.fn(),
  fetchAccountEmail: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("./claude-oauth-core", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getClaudeTokenCore,
  fetchAccountEmail,
}));

import { getUserClaudeSubscriptionStatus } from "./user-claude-subscription";
import { getClaudeSubscriptionStatus } from "./claude-subscription";

const ROW = {
  oauthAccessToken: { sealed: "x" },
  oauthExpiresAt: new Date("2026-10-18T12:00:00.000Z"),
};

const statuses: Array<[string, () => Promise<{ connected: boolean; expired?: boolean; email?: string | null }>]> = [
  ["personal", () => getUserClaudeSubscriptionStatus("user-1")],
  ["org", () => getClaudeSubscriptionStatus("org-1")],
];

beforeEach(() => {
  vi.clearAllMocks();
  prisma.userAiSettings.findUnique.mockResolvedValue(ROW);
  prisma.orgAiSettings.findUnique.mockResolvedValue(ROW);
  fetchAccountEmail.mockResolvedValue("me@example.com");
});

describe.each(statuses)("%s Claude subscription status", (_name, getStatus) => {
  it("is connected but EXPIRED when no usable token can be had", async () => {
    getClaudeTokenCore.mockResolvedValue(null);

    const s = await getStatus();

    expect(s.connected).toBe(true);
    expect(s.expired).toBe(true);
    expect(fetchAccountEmail).not.toHaveBeenCalled();
  });

  it("is connected and not expired when the token is usable", async () => {
    getClaudeTokenCore.mockResolvedValue("live-token");

    const s = await getStatus();

    expect(s.connected).toBe(true);
    expect(s.expired).toBe(false);
    expect(s.email).toBe("me@example.com");
  });
});
