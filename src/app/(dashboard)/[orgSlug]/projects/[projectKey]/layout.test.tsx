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
// The first fix put one check in this layout, on the reasoning that it is the
// ancestor of all of them and "if it refuses, nothing beneath it renders". That
// is not how it renders: a layout and its page run in parallel, and the page's
// output is streamed even when the layout calls notFound(). A non-member who
// opened a restricted project's PM dashboard got its risks and goals in the
// response, under a "not found" screen. So every page checks for itself.
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
 * Inside projects/[projectKey], every server file refuses before it reads: that
 * guard reads the syntax and lives in server-files-check-before-reading.arch.test.ts.
 *
 * Outside it: a page that reads a project by key does its own check too.
 */
describe("a project-reading page outside projects/[projectKey] checks visibility itself", () => {
  const SUBTREE = "src/app/(dashboard)/[orgSlug]/projects/[projectKey]";
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.name.endsWith(".tsx") && !e.name.includes(".test.")) out.push(p);
    }
    return out;
  }
  /** Source with comments stripped, so a comment about the check cannot pass. */
  const code = (f: string) =>
    readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

  it("each one calls a visibility check", () => {
    const outside = walk("src/app/(dashboard)").filter((f) => !f.startsWith(SUBTREE));
    // By key or as a list: a page that lists projects shows their names too.
    const reading = outside.filter((f) => /prisma\.project\.(findFirst|findUnique|findMany)\s*\(/.test(code(f)));
    // Guards the scan itself. Before this line it matched only by-key reads,
    // of which none remain outside the folder, so it checked nothing.
    expect(reading).toContain("src/app/(dashboard)/[orgSlug]/program-management/page.tsx");
    const offenders = reading.filter(
      (f) => !/\b(?:canReadProject|canReadInProject|isProjectVisible|getVisibleProjectIds|getReadableProjectIds)\s*\(/.test(code(f)),
    );
    expect(offenders, "these server-render project data and do not check visibility themselves").toEqual([]);
  });
});
