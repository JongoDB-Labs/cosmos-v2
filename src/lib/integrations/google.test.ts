// @vitest-environment node
//
// getGoogleClientForUser — the sealed ConnectorCredential store is now the SOLE
// source of truth (the legacy plaintext User.googleRefreshToken column was swept +
// DROPPED; the fallback/self-heal path is gone). This locks:
//  1. USER-SCOPED sealed read: a personal Google grant works in EVERY org the user
//     belongs to, so the read uses getUserCredential(provider,userId) and does NOT
//     re-narrow by the current org (strict org-scoping would regress non-primary orgs).
//  2. Graceful "Google not connected" when the user has no sealed token.
//  3. NO plaintext-column read at all (the column no longer exists).
// googleapis + credentials + prisma are mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma, getUserCredential, setCredential, oauthSetCredentials } = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    orgMember: { findFirst: vi.fn() },
  },
  getUserCredential: vi.fn(),
  setCredential: vi.fn(),
  oauthSetCredentials: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/integrations/credentials", () => ({ getUserCredential, setCredential }));
vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials = oauthSetCredentials;
      },
    },
  },
}));

import { getGoogleClientForUser } from "./google";

const ORG = "00000000-0000-0000-0000-0000000000aa";
const OTHER_ORG = "00000000-0000-0000-0000-0000000000cc";
const USER = "00000000-0000-0000-0000-0000000000bb";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getGoogleClientForUser", () => {
  it("uses the sealed credential and never touches a plaintext column", async () => {
    getUserCredential.mockResolvedValue({ refreshToken: "SEALEDTOK" });

    await getGoogleClientForUser(USER, ORG);

    // User-scoped lookup: by (provider, userId) only — never narrowed by org.
    expect(getUserCredential).toHaveBeenCalledWith("google", USER);
    expect(oauthSetCredentials).toHaveBeenCalledWith({ refresh_token: "SEALEDTOK" });
    // The dropped plaintext column is never read, and there is no self-heal write.
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(setCredential).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("resolves the user's Google grant in a NON-primary org (user-scoped, not org-scoped)", async () => {
    // The token was stored under the user's primary org (ORG), but the agent is acting
    // in a DIFFERENT org (OTHER_ORG). The user-scoped read must still find it — otherwise
    // multi-org users lose Google in their non-primary orgs (the regression we guard).
    getUserCredential.mockResolvedValue({ refreshToken: "SEALEDTOK" });

    await getGoogleClientForUser(USER, OTHER_ORG);

    expect(getUserCredential).toHaveBeenCalledWith("google", USER);
    expect(oauthSetCredentials).toHaveBeenCalledWith({ refresh_token: "SEALEDTOK" });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("resolves with no orgId passed (the read is user-scoped — no org needed)", async () => {
    getUserCredential.mockResolvedValue({ refreshToken: "SEALEDTOK" });

    await getGoogleClientForUser(USER); // no orgId

    expect(getUserCredential).toHaveBeenCalledWith("google", USER);
    expect(oauthSetCredentials).toHaveBeenCalledWith({ refresh_token: "SEALEDTOK" });
  });

  it("throws the graceful 'Google not connected' error when there is no sealed token", async () => {
    getUserCredential.mockResolvedValue(null);

    await expect(getGoogleClientForUser(USER, ORG)).rejects.toThrow(
      "Google not connected",
    );
    expect(setCredential).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
