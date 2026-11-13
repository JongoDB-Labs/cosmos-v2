// @vitest-environment node
//
// "Your sessions" lists the caller's own sign-ins. A session's id is the value
// of its sign-in cookie, which is httpOnly precisely so page script can't read
// it; listing it in a JSON response undid that. The list now carries an opaque
// id, and revoking takes that id. Against a real database.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db/client";

const h = vi.hoisted(() => ({ userId: "", sessionId: "" }));
vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: async () => ({ id: h.userId, sessionId: h.sessionId }),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (n === "session" ? { value: h.sessionId } : undefined) }),
}));

import { GET } from "./route";
import { DELETE } from "./[sessionId]/route";

const stamp = Math.random().toString(36).slice(2, 8);
const CURRENT = `me-current-${stamp}-${"c".repeat(24)}`;
const OTHER = `me-other-${stamp}-${"o".repeat(24)}`;

beforeAll(async () => {
  h.userId = (await prisma.user.create({ data: { email: `me-${stamp}@sess.test`, displayName: "Me" } })).id;
  h.sessionId = CURRENT;
  const expiresAt = new Date(Date.now() + 86_400_000);
  await prisma.session.create({ data: { id: CURRENT, userId: h.userId, expiresAt } });
  await prisma.session.create({ data: { id: OTHER, userId: h.userId, expiresAt } });
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { userId: h.userId } });
  await prisma.user.deleteMany({ where: { id: h.userId } });
});

const del = (id: string) =>
  DELETE(new Request("http://localhost/x", { method: "DELETE" }), { params: Promise.resolve({ sessionId: id }) });

describe("my sessions", () => {
  it("lists both sessions without either cookie value", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const text = await res.text();
    const rows = JSON.parse(text) as { id: string; isCurrent: boolean }[];
    // Positive control: both are listed, and the current one is marked.
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.isCurrent)).toHaveLength(1);
    expect(text).not.toContain(CURRENT);
    expect(text).not.toContain(OTHER);
  });

  it("revokes the other session by the id it lists, and refuses the current one", async () => {
    const rows = JSON.parse(await (await GET()).text()) as { id: string; isCurrent: boolean }[];
    const current = rows.find((r) => r.isCurrent)!;
    const other = rows.find((r) => !r.isCurrent)!;

    expect((await del(current.id)).status).toBe(400);
    expect(await prisma.session.findUnique({ where: { id: CURRENT } })).not.toBeNull();

    expect((await del(other.id)).status).toBe(204);
    expect(await prisma.session.findUnique({ where: { id: OTHER } })).toBeNull();
    expect(await prisma.session.findUnique({ where: { id: CURRENT } })).not.toBeNull();
  });

  it("an unknown id is a 404 and deletes nothing", async () => {
    expect((await del("not-a-real-id")).status).toBe(404);
    expect(await prisma.session.findUnique({ where: { id: CURRENT } })).not.toBeNull();
  });
});
