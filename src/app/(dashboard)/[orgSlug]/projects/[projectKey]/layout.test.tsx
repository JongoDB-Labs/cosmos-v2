// @vitest-environment node
//
// REPORTED: with a project's Visibility switch on, a non-member could still see
// the project's resources.
//
// The API gates were right — every route under projects/[projectId] goes through
// requireProjectRead. But Next.js server components fetch from Prisma DIRECTLY,
// bypassing the API entirely, and the conversion only swept src/app/api/**.
// 29 server components under projects/[projectKey] queried a project and checked
// only `if (!project) notFound()`.
//
// This layout is the single ancestor of all of them, so it is the choke point:
// if it refuses, nothing beneath it renders.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Permission } from "@/lib/rbac/permissions";
import { OrgRole } from "@prisma/client";

const { getAuthContext, prisma, notFound, redirect } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
  prisma: {
    project: { findFirst: vi.fn() },
    orgMember: { findUnique: vi.fn() },
    projectMember: { findFirst: vi.fn() },
    userPreferences: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getAuthContext }));
vi.mock("@/lib/db/client", () => ({ prisma }));
vi.mock("next/navigation", () => ({ notFound, redirect }));

import { canReadProject } from "@/lib/rbac/project-access";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

function ctx(over: Record<string, unknown> = {}) {
  const perms = Permission.PROJECT_READ | Permission.ITEM_READ;
  return {
    userId: "33333333-3333-4333-8333-333333333333",
    orgId: ORG_ID,
    orgRole: OrgRole.MEMBER,
    permissions: perms,
    basePermissions: perms,
    abacRules: [],
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

/**
 * The layout's own guard, exercised through the helper it must call. Rendering
 * the whole layout in a unit test would drag in the entire dashboard shell; what
 * matters here is the DECISION, and that it is reachable from a project key.
 */
describe("project layout visibility guard", () => {
  it("refuses a non-member when the project is limited to its members", async () => {
    prisma.project.findFirst.mockResolvedValue({
      id: PROJECT_ID,
      orgId: ORG_ID,
      teamScopedAccess: true,
    });
    prisma.orgMember.findUnique.mockResolvedValue({ id: "om1" });
    prisma.projectMember.findFirst.mockResolvedValue(null);

    expect(await canReadProject(ctx(), PROJECT_ID)).toBe(false);
  });

  it("allows a member of that project", async () => {
    prisma.project.findFirst.mockResolvedValue({
      id: PROJECT_ID,
      orgId: ORG_ID,
      teamScopedAccess: true,
    });
    prisma.orgMember.findUnique.mockResolvedValue({ id: "om1" });
    prisma.projectMember.findFirst.mockResolvedValue({ id: "pm1" });

    expect(await canReadProject(ctx(), PROJECT_ID)).toBe(true);
  });

  it("allows anyone on an unrestricted project — the default, unchanged", async () => {
    prisma.project.findFirst.mockResolvedValue({
      id: PROJECT_ID,
      orgId: ORG_ID,
      teamScopedAccess: false,
    });
    prisma.orgMember.findUnique.mockResolvedValue({ id: "om1" });
    prisma.projectMember.findFirst.mockResolvedValue(null);

    expect(await canReadProject(ctx(), PROJECT_ID)).toBe(true);
  });

  it("allows the org OWNER — break-glass, and why an owner testing this sees everything", async () => {
    prisma.project.findFirst.mockResolvedValue({
      id: PROJECT_ID,
      orgId: ORG_ID,
      teamScopedAccess: true,
    });
    prisma.orgMember.findUnique.mockResolvedValue({ id: "om1" });
    prisma.projectMember.findFirst.mockResolvedValue(null);

    expect(await canReadProject(ctx({ orgRole: OrgRole.OWNER }), PROJECT_ID)).toBe(true);
  });
});

/**
 * The structural claim: the layout must actually CALL the guard. A guard that
 * exists and is never invoked is what shipped, and no behavioural test of the
 * helper can catch it.
 */
describe("the layout wires the guard up", () => {
  it("imports and calls canReadProject before rendering", async () => {
    const src = readFileSync(
      "src/app/(dashboard)/[orgSlug]/projects/[projectKey]/layout.tsx",
      "utf8",
    );
    expect(src).toMatch(/canReadProject/);
    // …and acts on it, rather than merely computing it.
    expect(src).toMatch(/canReadProject\([^)]*\)\s*\)\s*\)?\s*notFound\(\)|!\(await canReadProject/);
  });
});

/**
 * Guards the CLASS.
 *
 * The layout protects everything BENEATH it. A project-scoped page added
 * somewhere else in the dashboard tree would not inherit that, and would
 * reintroduce exactly the reported bug — server-rendered project data with no
 * visibility check. This fails on such a page rather than trusting the next
 * person to know the layout is load-bearing.
 */
describe("no project-scoped page escapes the guarded subtree", () => {
  const GUARDED = "src/app/(dashboard)/[orgSlug]/projects/[projectKey]";

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.name.endsWith(".tsx") && !e.name.includes(".test.")) out.push(p);
    }
    return out;
  }

  it("finds dashboard pages at all (guards the scan itself)", () => {
    expect(walk("src/app/(dashboard)").length).toBeGreaterThan(20);
  });

  it("keeps every project-reading server component under the guarded layout", () => {
    const offenders = walk("src/app/(dashboard)")
      .filter((f) => !f.startsWith(GUARDED))
      .filter((f) => /prisma\.project\.(findFirst|findUnique)/.test(readFileSync(f, "utf8")))
      // A file that does its own visibility check is fine wherever it lives.
      .filter(
        (f) =>
          !/canReadProject|isProjectVisible|getVisibleProjectIds/.test(
            readFileSync(f, "utf8"),
          ),
      );

    expect(
      offenders,
      "these server-render project data outside the guarded layout and do not " +
        "check visibility themselves — call canReadProject, or move them under " +
        "projects/[projectKey]",
    ).toEqual([]);
  });
});
