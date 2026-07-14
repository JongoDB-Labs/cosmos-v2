// @vitest-environment node
//
// Skin is a USER-scoped preference cached in a device-level `skin` cookie
// (see apply-saved-skin.tsx). On a shared/kiosk browser, that cookie must not
// survive into the next person's session — logout clears it alongside the
// session cookie so the next sign-in starts from a clean resolution instead
// of inheriting whoever was previously signed in on this browser.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/client";
import { SKIN_COOKIE } from "@/lib/theme/cookie";

const { prisma } = vi.hoisted(() => ({
  prisma: { session: { delete: vi.fn() } },
}));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { GET, POST } from "./route";

function reqWithCookies(cookieHeader: string, method: "GET" | "POST" = "POST") {
  return new NextRequest("http://localhost/api/auth/logout", {
    method,
    headers: { cookie: cookieHeader },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.session.delete.mockResolvedValue({});
});

describe("logout — clears the skin cookie (device-level cache)", () => {
  it("deletes both the session and skin cookies, and redirects to /login", async () => {
    const res = await POST(reqWithCookies(`${SESSION_COOKIE}=sess-123; ${SKIN_COOKIE}=atelier`));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.cookies.get(SESSION_COOKIE)?.value).toBe("");
    expect(res.cookies.get(SKIN_COOKIE)?.value).toBe("");
    expect(prisma.session.delete).toHaveBeenCalledWith({ where: { id: "sess-123" } });
  });

  it("still clears the skin cookie when there is no session cookie to begin with", async () => {
    const res = await GET(reqWithCookies(`${SKIN_COOKIE}=atelier`, "GET"));

    expect(res.status).toBe(303);
    expect(res.cookies.get(SKIN_COOKIE)?.value).toBe("");
    expect(prisma.session.delete).not.toHaveBeenCalled();
  });
});
