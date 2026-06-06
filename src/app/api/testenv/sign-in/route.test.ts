// @vitest-environment node
//
// Hardening lock for the test-only auth-bypass route (spec §8 gate 8).
//
// The route mints a session for any known email — catastrophic if reachable in
// prod. Two independent gates must hold:
//   1. NODE_ENV === "production"  → hard 404 BEFORE anything else (belt), so a
//      leaked E2E_TEST_AUTH=1 in a prod image still can't mint a session.
//   2. E2E_TEST_AUTH !== "1"      → 404 (suspenders) in non-prod.
// Only when NOT prod AND E2E_TEST_AUTH=1 does the route run.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// --- I/O boundary mocks ------------------------------------------------------
const { prisma } = vi.hoisted(() => ({
  prisma: {
    user: { findFirst: vi.fn() },
    session: { create: vi.fn() },
  },
}));

vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("@/lib/auth/client", () => ({
  SESSION_COOKIE: "session",
  SESSION_MAX_AGE_SECONDS: 60 * 60 * 24 * 30,
}));

import { POST } from "./route";

function postRequest(body: unknown = { email: "alice@example.com" }): NextRequest {
  return new NextRequest("http://localhost/api/testenv/sign-in", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // vi.stubEnv is type-safe (NODE_ENV is a read-only literal type under tsc);
  // unstub restores the real process.env between tests.
  vi.unstubAllEnvs();
});

describe("POST /api/testenv/sign-in — production guard", () => {
  it("returns 404 in production even when E2E_TEST_AUTH=1 (env leak)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("E2E_TEST_AUTH", "1"); // the leak we are defending against

    const res = await POST(postRequest());

    expect(res.status).toBe(404);
    // Hard guard runs FIRST — no body parse, no DB lookup, no session minted.
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.session.create).not.toHaveBeenCalled();
  });

  it("returns 404 when E2E_TEST_AUTH is unset (non-prod)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("E2E_TEST_AUTH", "");

    const res = await POST(postRequest());

    expect(res.status).toBe(404);
    expect(prisma.session.create).not.toHaveBeenCalled();
  });

  it("mints a session only when NOT prod AND E2E_TEST_AUTH=1", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("E2E_TEST_AUTH", "1");
    prisma.user.findFirst.mockResolvedValue({ id: "user-1", email: "alice@example.com" });
    prisma.session.create.mockResolvedValue({});

    const res = await POST(postRequest());

    expect(res.status).toBe(200);
    expect(prisma.session.create).toHaveBeenCalledOnce();
    expect(res.headers.get("set-cookie")).toContain("session=");
  });
});
