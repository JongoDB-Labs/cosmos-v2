// @vitest-environment node
//
// Regression guard for feedback screenshot uploads (COSMOS-97). Runs the real
// POST handler against the seeded e2e DB (`test-org` / alice), with only
// `getAuthContext` and the storage adapter mocked — session cookies aren't
// available in a route-handler test, and we don't want the local adapter
// writing to disk. Proves:
//   - a PNG whose filename has spaces AND a colon (the exact macOS-screenshot
//     shape from the bug report) uploads with 201, the raw filename preserved
//     on the row, and the storageKey sanitized to an ASCII-safe path;
//   - the failure contract the client now depends on: an oversized file → 413
//     `too_large` (with `maxBytes`), an unsupported type → 415 `unsupported_mime`.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { OrgRole } from "@prisma/client";
import type { AuthContext } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";

const { getAuthContext, storagePut } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  storagePut: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/storage", () => ({
  getStorage: () => ({
    put: storagePut,
    delete: vi.fn().mockResolvedValue(undefined),
    stream: vi.fn(),
  }),
}));

import { prisma } from "@/lib/db/client";
import { POST } from "./route";

// Minimal valid 1x1 PNG (real magic bytes, so file-type sniffs image/png).
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

let orgId: string;
let userId: string;
const createdIds: string[] = [];

function params() {
  return Promise.resolve({ orgId });
}

function upload(file: File) {
  const fd = new FormData();
  fd.append("file", file);
  return new NextRequest(`http://localhost/api/v1/orgs/${orgId}/feedback/attachments`, {
    method: "POST",
    body: fd,
  });
}

beforeAll(async () => {
  const org = await prisma.organization.findFirstOrThrow({
    where: { slug: "test-org" },
    select: { id: true },
  });
  orgId = org.id;

  const user = await prisma.user.findFirstOrThrow({
    where: { email: "alice@test.local" },
    select: { id: true },
  });
  userId = user.id;

  const ctx: AuthContext = {
    userId,
    orgId,
    orgRole: OrgRole.MEMBER,
    permissions: Permission.ORG_READ,
    basePermissions: Permission.ORG_READ,
    abacRules: [],
  };
  getAuthContext.mockResolvedValue(ctx);
  storagePut.mockResolvedValue({ url: "", storageKey: "" });
  // Keep the probabilistic GC sweep from firing mid-test.
  vi.spyOn(Math, "random").mockReturnValue(0.99);
});

afterAll(async () => {
  if (createdIds.length) {
    await prisma.feedbackAttachment.deleteMany({ where: { id: { in: createdIds } } });
  }
  vi.restoreAllMocks();
});

describe("POST /feedback/attachments (e2e)", () => {
  it("uploads a PNG whose filename has spaces and a colon", async () => {
    const filename = "Screenshot 2026-07-10 at 2:27:10 PM.png";
    const file = new File([PNG_BYTES], filename, { type: "image/png" });

    const res = await POST(upload(file), { params: params() });
    expect(res.status).toBe(201);
    const row = await res.json();
    createdIds.push(row.id);

    // Raw filename is preserved for display…
    expect(row.filename).toBe(filename);
    expect(row.kind).toBe("image");
    expect(row.contentType).toBe("image/png");
    // …but the storage key is ASCII-safe: no spaces or colons.
    expect(row.storageKey).toMatch(
      /^[0-9a-f-]+\/feedback\/[0-9a-f-]+\/Screenshot_2026-07-10_at_2_27_10_PM\.png$/,
    );
    expect(row.storageKey).not.toMatch(/[ :]/);

    // Persisted with the raw filename intact.
    const persisted = await prisma.feedbackAttachment.findUniqueOrThrow({
      where: { id: row.id },
      select: { filename: true, storageKey: true },
    });
    expect(persisted.filename).toBe(filename);
    expect(storagePut).toHaveBeenCalled();
  });

  it("rejects an oversized file with 413 too_large", async () => {
    // 8 MB + 1 byte; content is irrelevant — size is checked before sniffing.
    const big = new File([new Uint8Array(8 * 1024 * 1024 + 1)], "huge.png", {
      type: "image/png",
    });
    const res = await POST(upload(big), { params: params() });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe("too_large");
    expect(body.maxBytes).toBe(8 * 1024 * 1024);

    const leaked = await prisma.feedbackAttachment.findFirst({
      where: { orgId, filename: "huge.png" },
      select: { id: true },
    });
    expect(leaked).toBeNull();
  });

  it("rejects an unsupported type with 415 unsupported_mime", async () => {
    const txt = new File([Buffer.from("just some notes, not an image")], "notes.txt", {
      type: "text/plain",
    });
    const res = await POST(upload(txt), { params: params() });
    expect(res.status).toBe(415);
    const body = await res.json();
    expect(body.error).toBe("unsupported_mime");

    const leaked = await prisma.feedbackAttachment.findFirst({
      where: { orgId, filename: "notes.txt" },
      select: { id: true },
    });
    expect(leaked).toBeNull();
  });
});
