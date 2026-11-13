import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";

type SqlClient = Pick<Prisma.TransactionClient, "$queryRaw">;

export interface OrgSettingsPatch {
  /** Top-level keys to replace. */
  set?: Record<string, Prisma.InputJsonValue>;
  /** One top-level key whose object gets these fields merged in. Fields not
   *  named are kept; a stored value that isn't an object is replaced. */
  merge?: { key: string; fields: Record<string, Prisma.InputJsonValue> };
  /** Top-level keys to delete. */
  remove?: string[];
}

/**
 * Change only the named keys of `Organization.settings`, in ONE statement, and
 * return the settings as they were just before (null when the org is gone).
 *
 * `settings` is one JSON object shared by many features. Reading it, changing a
 * key in memory and writing the whole object back puts every other key back as
 * it was at the read, so any change made in between is lost. That includes the
 * instance operator turning feedback automation off, which such a write would
 * quietly turn back on with no audit row. This writes only what it is given,
 * against the row as it is when the write happens (the same approach as
 * patchCqlSettings).
 */
export async function patchOrgSettings(
  orgId: string,
  patch: OrgSettingsPatch,
  db: SqlClient = prisma,
): Promise<Record<string, unknown> | null> {
  const merge = patch.merge
    ? Prisma.sql`|| jsonb_build_object(
          ${patch.merge.key}::text,
          COALESCE(
            CASE WHEN jsonb_typeof(o.settings -> ${patch.merge.key}::text) = 'object'
                 THEN o.settings -> ${patch.merge.key}::text END,
            '{}'::jsonb
          ) || ${JSON.stringify(patch.merge.fields)}::jsonb
        )`
    : Prisma.empty;
  const rows = await db.$queryRaw<{ before: unknown }[]>(Prisma.sql`
    WITH old AS (SELECT settings FROM organizations WHERE id = ${orgId}::uuid FOR UPDATE)
    UPDATE organizations o
       SET settings = (CASE WHEN jsonb_typeof(o.settings) = 'object' THEN o.settings ELSE '{}'::jsonb END
                        - ${patch.remove ?? []}::text[])
                      || ${JSON.stringify(patch.set ?? {})}::jsonb
                      ${merge},
           updated_at = now()
      FROM old
     WHERE o.id = ${orgId}::uuid
    RETURNING old.settings AS before`);
  if (rows.length === 0) return null;
  const before = rows[0].before;
  return before && typeof before === "object" && !Array.isArray(before) ? (before as Record<string, unknown>) : {};
}
