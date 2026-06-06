// @vitest-environment node
//
// getGoogleClientForUser — locks the self-healing drain of the legacy plaintext
// refresh token: sealed-store-first, plaintext fallback, and on a fallback hit it
// MUST seal into the vault AND null the plaintext column (no plaintext at rest after
// first use). googleapis + credentials + prisma are mocked.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma, getCredential, setCredential, oauthSetCredentials } = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    orgMember: { findFirst: vi.fn() },
  },
  getCredential: vi.fn(),
  setCredential: vi.fn(),
  oauthSetCredentials: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/integrations/credentials", () => ({ getCredential, setCredential }));
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
const USER = "00000000-0000-0000-0000-0000000000bb";

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.update.mockResolvedValue({});
  setCredential.mockResolvedValue(undefined);
});

describe("getGoogleClientForUser", () => {
  it("uses the sealed credential when present and does NOT touch the plaintext column", async () => {
    getCredential.mockResolvedValue({ refreshToken: "SEALEDTOK" });

    await getGoogleClientForUser(USER, ORG);

    expect(getCredential).toHaveBeenCalledWith(ORG, "google", USER);
    expect(oauthSetCredentials).toHaveBeenCalledWith({ refresh_token: "SEALEDTOK" });
    // No fallback read, no self-heal write when the sealed store already has it.
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(setCredential).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("self-heals: seals the legacy plaintext token AND nulls the plaintext column", async () => {
    getCredential.mockResolvedValue(null); // nothing sealed yet
    prisma.user.findUnique.mockResolvedValue({ googleRefreshToken: "LEGACYTOK" });

    await getGoogleClientForUser(USER, ORG);

    // The legacy token still resolves the client this call...
    expect(oauthSetCredentials).toHaveBeenCalledWith({ refresh_token: "LEGACYTOK" });
    // ...and it is drained: sealed into the vault THEN the plaintext column nulled.
    expect(setCredential).toHaveBeenCalledWith(ORG, "google", USER, {
      refreshToken: "LEGACYTOK",
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: USER },
      data: { googleRefreshToken: null },
    });
  });

  it("resolves the user's primary org for the heal when no orgId was passed", async () => {
    prisma.user.findUnique.mockResolvedValue({ googleRefreshToken: "LEGACYTOK" });
    prisma.orgMember.findFirst.mockResolvedValue({ orgId: ORG });

    await getGoogleClientForUser(USER); // no orgId

    expect(getCredential).not.toHaveBeenCalled(); // can't read sealed without an org
    expect(prisma.orgMember.findFirst).toHaveBeenCalled();
    expect(setCredential).toHaveBeenCalledWith(ORG, "google", USER, {
      refreshToken: "LEGACYTOK",
    });
  });

  it("throws the graceful 'Google not connected' error when neither source has a token", async () => {
    getCredential.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({ googleRefreshToken: null });

    await expect(getGoogleClientForUser(USER, ORG)).rejects.toThrow(
      "Google not connected",
    );
    expect(setCredential).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("does not break the call when the self-heal write fails (best-effort)", async () => {
    getCredential.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({ googleRefreshToken: "LEGACYTOK" });
    setCredential.mockRejectedValue(new Error("db down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // The legacy token still produces a working client even though sealing failed.
    await getGoogleClientForUser(USER, ORG);
    expect(oauthSetCredentials).toHaveBeenCalledWith({ refresh_token: "LEGACYTOK" });
    warn.mockRestore();
  });
});
