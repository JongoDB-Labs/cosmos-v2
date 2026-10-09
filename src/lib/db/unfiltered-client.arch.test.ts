// `prismaUnfiltered` can see removed members. Every importer is listed here.
//
// Removal is a soft delete: the `org_members` row survives with `removedAt` set, so a
// person's comments, assignments and audit trail stay attributable instead of decaying
// into bare uuids. That retention is only safe while a removed membership stops
// satisfying a membership read, which src/lib/db/client.ts arranges by filtering every
// `orgMember` read issued through the default client.
//
// `prismaUnfiltered` opts out of that. There are ~67 `orgMember` query sites, including
// every RBAC and auth path, and reaching for the unfiltered client at the wrong one
// keeps a removed person's access alive — which no feature test is looking for, because
// everything about the feature still works. So the opt-out is enumerated: adding a file
// here is a deliberate act with a reason attached, not a convenience.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = "src";

/** Files that legitimately see removed members, with the reason. */
const ALLOWED: Record<string, string> = {
  "src/lib/db/client.ts": "Defines and exports it.",

  "src/app/api/v1/orgs/[orgId]/members/route.ts":
    "MEMBERSHIP LIFECYCLE. Re-adding someone who was removed has to find their " +
    "retained row: `@@unique([orgId, userId])` makes a second row impossible, so " +
    "the filtered client would report them absent and send the request straight " +
    "into a constraint violation. It reinstates that row instead.",

  "src/lib/auth/sso.ts":
    "MEMBERSHIP LIFECYCLE. The upsert must land on the retained row and clear " +
    "`removedAt`, or SSO accepts the login while every membership read filters the " +
    "person away — a silent lockout. It also keeps a removed OWNER recognisable as " +
    "OWNER, so reinstating cannot downgrade them.",

  "src/lib/mentions/registry.server.ts":
    "HISTORICAL ATTRIBUTION. `resolve` turns the `<@uuid>` tokens already stored in " +
    "comments and notes back into names, so it must answer for people since " +
    "removed. Scoped to `orgId`, so it cannot name a user from another org. The " +
    "`search` handler beside it stays filtered — a removed person is not mentionable.",

  "src/app/api/v1/orgs/[orgId]/export/json/route.ts":
    "HISTORICAL ATTRIBUTION. A whole-org archive carries former members too, told " +
    "apart by `removedAt`; dropping them would make the export disagree with the " +
    "history exported alongside it.",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      out.push(...walk(p));
    } else if (/\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

describe("prismaUnfiltered — the removed-member opt-out is enumerated", () => {
  const importers = walk(ROOT)
    .filter((f) => !/\.test\.tsx?$/.test(f) && !f.includes("__tests__"))
    .filter((f) => /\bprismaUnfiltered\b/.test(readFileSync(f, "utf8")))
    .map((f) => f.split("\\").join("/"))
    .sort();

  it("is imported only by allowlisted files", () => {
    const unexpected = importers.filter((f) => !(f in ALLOWED));
    expect(
      unexpected,
      "Reaching for prismaUnfiltered makes removed members visible again. If this " +
        "file is doing membership lifecycle or historical attribution, add it to " +
        "ALLOWED with the reason. If it is answering 'is this person a member?', it " +
        "wants the default `prisma` instead.",
    ).toEqual([]);
  });

  it("has no stale allowlist entries", () => {
    // A reason left behind for a file that no longer opts out reads as justification
    // for an exemption nobody is taking, and the next reader trusts it.
    const stale = Object.keys(ALLOWED).filter((f) => !importers.includes(f));
    expect(stale).toEqual([]);
  });

  it("gives every opt-out a substantive reason", () => {
    // client.ts only declares the export; everything else is actually opting out, and
    // "membership lifecycle" / "historical attribution" is the distinction a reviewer
    // needs to see spelled out.
    for (const f of importers.filter((f) => f !== "src/lib/db/client.ts")) {
      expect(ALLOWED[f]?.length ?? 0, `${f} needs a reason`).toBeGreaterThan(40);
    }
  });
});
