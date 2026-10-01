import { describe, it, expect, vi, beforeEach } from "vitest";

const { prisma } = vi.hoisted(() => ({ prisma: { user: { findMany: vi.fn() } } }));
vi.mock("@/lib/db/client", () => ({ prisma }));

import { uploadersByIds, withUploaders, FORMER_MEMBER } from "../uploader";

const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findMany.mockResolvedValue([]);
});

/**
 * `Document.uploadedById` has no foreign key on purpose — a file has to outlive the
 * account that uploaded it — so a name is resolved here rather than joined. These are
 * about doing that once per page, and about the gone-account case being a label
 * rather than a crash or a dropped row.
 */
describe("uploadersByIds", () => {
  it("asks for each id once, however many rows carried it", async () => {
    prisma.user.findMany.mockResolvedValue([{ id: A, displayName: "A", avatarUrl: null }]);
    await uploadersByIds([A, A, A, B, A]);
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.findMany.mock.calls[0][0].where.id.in).toEqual([A, B]);
  });

  it("does not go to the database at all for an empty page", async () => {
    expect((await uploadersByIds([])).size).toBe(0);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });
});

describe("withUploaders", () => {
  it("replaces the uuid with the person and removes the raw column", async () => {
    prisma.user.findMany.mockResolvedValue([
      { id: A, displayName: "Maggie", avatarUrl: "/m.png" },
    ]);
    const [row] = await withUploaders([{ id: "d1", uploadedById: A }]);
    expect(row.uploadedBy).toEqual({ id: A, displayName: "Maggie", avatarUrl: "/m.png" });
    // A list of user uuids is a roster. The id stays on the uploader object, where
    // it belongs to a row the caller can already see a name for.
    expect(row).not.toHaveProperty("uploadedById");
  });

  it("keeps the row when the account is gone, and says so", async () => {
    prisma.user.findMany.mockResolvedValue([]);
    const [row] = await withUploaders([{ id: "d1", uploadedById: A }]);
    // Dropping the row would hide a file; saying "Unknown" would imply the id is
    // not known, and it is. The person is what is missing.
    expect(row.uploadedBy).toEqual({ id: A, ...FORMER_MEMBER });
    expect(FORMER_MEMBER.displayName).toBe("Former member");
  });

  it("resolves a mixed page without letting one gone account affect the others", async () => {
    prisma.user.findMany.mockResolvedValue([{ id: B, displayName: "Rachel", avatarUrl: null }]);
    const rows = await withUploaders([
      { id: "d1", uploadedById: A },
      { id: "d2", uploadedById: B },
    ]);
    expect(rows.map((r) => r.uploadedBy.displayName)).toEqual(["Former member", "Rachel"]);
  });

  it("carries every other field through untouched", async () => {
    prisma.user.findMany.mockResolvedValue([{ id: A, displayName: "A", avatarUrl: null }]);
    const [row] = await withUploaders([
      { id: "d1", uploadedById: A, filename: "a.pdf", size: 9, nested: { k: 1 } },
    ]);
    expect(row).toMatchObject({ id: "d1", filename: "a.pdf", size: 9, nested: { k: 1 } });
  });
});
