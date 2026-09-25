// @vitest-environment node
//
// POST reads `mode` from the MULTIPART BODY only. Both real callers
// (components/settings/preferences-form.tsx) `fd.append("mode", ...)` and send no
// query string; only DELETE uses `?mode=`. The POST handler briefly also accepted
// `?mode=` as a fallback, which meant a body missing the required field was
// silently satisfied by the query — so this asserts the query is NOT consulted.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { getCurrentUser, prisma } = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  prisma: { userPreferences: { upsert: vi.fn(), findUnique: vi.fn() } },
}));

vi.mock("@/lib/auth/session", () => ({ getCurrentUser }));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { POST } from "./route";

function upload(query: string, fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append("file", new File([new Uint8Array([1, 2, 3])], "bg.png", { type: "image/png" }));
  return new NextRequest(`http://localhost/api/v1/me/background${query}`, {
    method: "POST",
    body: fd,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentUser.mockResolvedValue({ id: "user-1" });
});

describe("POST /api/v1/me/background — mode comes from the form body", () => {
  it("rejects an upload whose mode is only in the query string", async () => {
    const res = await POST(upload("?mode=dark", {}));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'mode must be "dark" or "light"' });
    expect(prisma.userPreferences.upsert).not.toHaveBeenCalled();
  });
});
