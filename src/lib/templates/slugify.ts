import { prisma } from "@/lib/db/client";

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

export async function uniqueSlug(
  table: "projectTemplate" | "boardTemplate",
  base: string,
  orgId: string,
): Promise<string> {
  const slug = slugify(base);
  let suffix = 1;

  while (true) {
    const candidate = suffix === 1 ? slug : `${slug}-${suffix}`;
    const existing =
      table === "projectTemplate"
        ? await prisma.projectTemplate.findFirst({ where: { orgId, slug: candidate } })
        : await prisma.boardTemplate.findFirst({ where: { orgId, slug: candidate } });
    if (!existing) return candidate;
    suffix++;
  }
}

/** A human-readable, project-unique board slug derived from its name (matches the
 *  Board `@@unique([projectId, slug])` constraint). Empty/symbol-only names fall
 *  back to "board". Collisions get a -2, -3, … suffix. */
export async function uniqueBoardSlug(base: string, projectId: string): Promise<string> {
  const slug = slugify(base) || "board";
  let suffix = 1;
  while (true) {
    const candidate = suffix === 1 ? slug : `${slug}-${suffix}`;
    const existing = await prisma.board.findFirst({ where: { projectId, slug: candidate } });
    if (!existing) return candidate;
    suffix++;
  }
}

export async function uniqueKey(
  base: string,
  orgId: string,
): Promise<string> {
  const key = base;
  let suffix = 1;

  while (true) {
    const candidate = suffix === 1 ? key : `${key}-${suffix}`;
    const existing = await prisma.workItemType.findFirst({
      where: { orgId, key: candidate },
    });
    if (!existing) return candidate;
    suffix++;
  }
}
