import { prisma } from "@/lib/db/client";

/**
 * Who uploaded a file, resolved for display.
 *
 * `Document.uploadedById` is a bare uuid with no foreign key, and that is correct:
 * the row has to outlive the account it names. A file uploaded three years ago must
 * still say who uploaded it after they leave, so a hard FK is wrong in both
 * directions — SetNull would erase the attribution, Restrict would make a departure
 * un-processable. The cost is that nothing joins, so a name has to be resolved here.
 */
export interface Uploader {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
}

/** Shown where the account behind an id no longer exists. Not "Unknown": the id IS
 *  known and auditable, it is the person who is gone, and saying so is the honest
 *  reading of a file uploaded by somebody who has since left. */
export const FORMER_MEMBER: Omit<Uploader, "id"> = {
  displayName: "Former member",
  avatarUrl: null,
};

/**
 * One batched lookup for every uploader on a page, mirroring how the activity feed
 * hydrates its actors. Never N+1: callers pass the whole page.
 */
export async function uploadersByIds(ids: readonly string[]): Promise<Map<string, Uploader>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, displayName: true, avatarUrl: true },
  });
  return new Map(users.map((u) => [u.id, u]));
}

/**
 * Attach `uploadedBy` to a page of documents and drop the raw id from the response.
 *
 * The id is deliberately NOT returned: a list of user uuids is a roster, and this
 * route is readable by anyone who can read the org. The uploader object carries the
 * id for the rows the caller may already see a name for, which is the same exposure
 * the activity feed already has.
 */
export async function withUploaders<T extends { uploadedById: string }>(
  docs: readonly T[],
): Promise<Array<Omit<T, "uploadedById"> & { uploadedBy: Uploader }>> {
  const byId = await uploadersByIds(docs.map((d) => d.uploadedById));
  return docs.map((d) => {
    const { uploadedById, ...rest } = d;
    return {
      ...rest,
      uploadedBy: byId.get(uploadedById) ?? { id: uploadedById, ...FORMER_MEMBER },
    };
  });
}
