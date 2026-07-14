// @vitest-environment node
//
// Skin is a USER-scoped preference (UserPreferences.skinId), not a device
// setting — POST /api/skin must persist it for the authenticated user in
// addition to seeding the first-paint cookie cache, so a stale cookie in a
// shared browser can never outlive the pref that's actually authoritative
// (see apply-saved-skin.tsx precedence). getCurrentUser + prisma are mocked
// (no session cookies / DB in a route-handler unit test); the DB assertions
// below check the exact upsert shape rather than hitting a real database.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { SKIN_COOKIE } from "@/lib/theme/cookie";

const { getCurrentUser, prisma } = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  prisma: { userPreferences: { upsert: vi.fn() } },
}));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser }));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { POST } from "./route";

const USER_ID = "99999999-9999-9999-9999-999999999999";

function req(body: unknown) {
  return new NextRequest("http://localhost/api/skin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentUser.mockResolvedValue({ id: USER_ID });
  prisma.userPreferences.upsert.mockResolvedValue({});
});

describe("POST /api/skin", () => {
  it("sets the cookie for a valid skin", async () => {
    const res = await POST(req({ skin: "atelier" }));
    expect(res.status).toBe(200);
    expect(res.cookies.get(SKIN_COOKIE)?.value).toBe("atelier");
  });
  it("clears the cookie for null", async () => {
    const res = await POST(req({ skin: null }));
    expect(res.status).toBe(200);
    expect(res.cookies.get(SKIN_COOKIE)?.value).toBe("");
  });
  it("400 on an unknown skin", async () => {
    const res = await POST(req({ skin: "bogus" }));
    expect(res.status).toBe(400);
  });

  describe("DB persistence — the user-scoped fix", () => {
    it("upserts the authenticated user's skinId in UserPreferences", async () => {
      const res = await POST(req({ skin: "atelier" }));
      expect(res.status).toBe(200);
      expect(prisma.userPreferences.upsert).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        create: { userId: USER_ID, skinId: "atelier" },
        update: { skinId: "atelier" },
      });
    });

    it("clears the persisted skinId when skin is null", async () => {
      const res = await POST(req({ skin: null }));
      expect(res.status).toBe(200);
      expect(prisma.userPreferences.upsert).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        create: { userId: USER_ID, skinId: null },
        update: { skinId: null },
      });
    });

    it("does not touch the DB for an invalid skin (400, rejected before persistence)", async () => {
      const res = await POST(req({ skin: "bogus" }));
      expect(res.status).toBe(400);
      expect(prisma.userPreferences.upsert).not.toHaveBeenCalled();
    });

    it("falls back to cookie-only when there is no authenticated user", async () => {
      getCurrentUser.mockResolvedValue(null);
      const res = await POST(req({ skin: "atelier" }));
      expect(res.status).toBe(200);
      expect(res.cookies.get(SKIN_COOKIE)?.value).toBe("atelier");
      expect(prisma.userPreferences.upsert).not.toHaveBeenCalled();
    });
  });
});
