import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  finishUniqueRead,
  isFilterable,
  isUniqueRead,
  planUniqueRead,
  withActiveFilter,
} from "./active-org-members";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Prisma 7 requires a driver adapter: the connection URL is no longer embedded in the
// generated client (it left schema.prisma — see prisma.config.ts). PrismaPg builds a
// node-postgres pool from DATABASE_URL, the same env var the v6 client resolved via the
// schema's `env("DATABASE_URL")`, so runtime connection behavior is unchanged.
const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

/**
 * Removing someone from an org no longer deletes their `org_members` row — it sets
 * `removedAt`, so their comments, assignments and audit trail stay attributable, and
 * the rows that cascade from the membership (project_members, org_member_work_roles)
 * survive. See prisma/migrations/20261005140000_org_member_soft_delete.
 *
 * That retention is only safe if a removed member stops reading as a member. There are
 * ~67 `orgMember` query sites, including every RBAC and auth path, and an omitted
 * filter at any one of them keeps a removed person's access alive — a silent failure
 * no test naturally looks for. So the filter is applied HERE, by default, to every read
 * issued through this client, rather than written out at each call site.
 *
 * Two things this deliberately does NOT cover, because neither can be done correctly at
 * this layer:
 *  - NESTED relation loads (`organization.findMany({ include: { members: true } })`)
 *    bypass model-level query hooks. Those sites filter explicitly.
 *  - `update`/`delete`/`upsert` address a row by unique key, where a non-unique
 *    `removedAt` clause is not valid input. Membership-lifecycle code owns those.
 */
const activeOrgMembersOnly = Prisma.defineExtension({
  name: "active-org-members-only",
  query: {
    orgMember: {
      async $allOperations({ operation, args, query }) {
        // The rule itself lives in ./active-org-members, where it is unit-tested.
        if (isFilterable(operation)) {
          return query(withActiveFilter(args as Record<string, unknown>));
        }

        if (isUniqueRead(operation)) {
          const plan = planUniqueRead(args as Record<string, unknown>);
          const row = (await query(plan.args)) as Record<string, unknown> | null;
          const verdict = finishUniqueRead(row, plan.injected);
          if (verdict.removed) {
            if (operation === "findUniqueOrThrow") {
              throw new Prisma.PrismaClientKnownRequestError(
                "No OrgMember found (the membership was removed)",
                { code: "P2025", clientVersion: Prisma.prismaVersion.client },
              );
            }
            return null;
          }
          return verdict.row;
        }

        return query(args);
      },
    },
  },
});

const base =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

/**
 * The client WITHOUT the removed-member filter. Reserved for the two jobs that have to
 * see removed rows: membership lifecycle (re-adding someone whose retained row would
 * otherwise collide with `@@unique([orgId, userId])`) and historical attribution
 * (resolving a past author or assignee to a name).
 *
 * Every importer is allowlisted in src/lib/db/__tests__/unfiltered-client-allowlist.test.ts
 * — adding one is a deliberate act with a security review attached, not a convenience.
 */
export const prismaUnfiltered = base;

// Cast back to `PrismaClient`: a query-only extension leaves every model method
// signature untouched, and keeping the exported type identical means the 579 modules
// importing `prisma` — and the plugin boundary in src/lib/plugins/registry.ts, which
// separate plugin repos type against — need no change.
export const prisma = base.$extends(activeOrgMembersOnly) as unknown as PrismaClient;

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = base;
