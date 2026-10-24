// @vitest-environment node
//
// Every write under projects/[projectId] must pass a gate that holds a
// project-scoped API key to its projects. Most writes used to gate on bits and
// roles alone (requireAccess, requireProjectManage, canManageProject), none of
// which looked at `projectScope`, so a key limited to one project could create
// and delete work in another. Those gates now ask `inKeyProjectScope` first;
// this scan keeps a new write from skipping all of them.
//
// It reads each POST/PUT/PATCH/DELETE handler with the module's own helpers and
// relative imports (gate-bits' handlerCode). requireAccess counts only when it
// is handed a projectId, the one way it can tell which project is meant.
import { describe, it, expect } from "vitest";
import { globSync, readFileSync } from "node:fs";
import { handlerCode } from "./gate-bits";

/** Gates that refuse a key outside its project scope. */
const SCOPE_GATE = new RegExp(
  String.raw`\b(?:requireProjectRead|assertProjectRead|requireProjectManage|canAdministerProject|canManageProject|` +
    String.raw`canWriteInProject|canManageBoardsInProject|isProjectVisible|readableDocument|inKeyProjectScope|` +
    String.raw`getReadableProjectIds|readableItemProjectId|getManagedProjectIds)\(` +
    String.raw`|\brequireAccess\([^;]*\bprojectId\b`,
);

const ROUTES = "src/app/api/v1/orgs/[[]orgId]/projects/[[]projectId]/**/route.ts";

/** The write handlers among these route modules that reach no scope gate. */
function unscopedWritesIn(routes: { file: string; src: string }[]): string[] {
  const out: string[] = [];
  for (const { file, src } of routes) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const code = handlerCode(src, method, file);
      if (code && !SCOPE_GATE.test(code)) out.push(`${method} ${file.replace(/^src\/app\/api\//, "")}`);
    }
  }
  return out.sort();
}

const unscopedWrites = () => unscopedWritesIn(globSync(ROUTES).map((file) => ({ file, src: readFileSync(file, "utf8") })));

const PLANTED = "src/app/api/v1/orgs/[orgId]/projects/[projectId]/planted/route.ts";

describe("project writes hold a key to its projects", () => {
  it("scans a real surface (not vacuous)", () => {
    const writes = globSync(ROUTES).flatMap((f) => {
      const src = readFileSync(f, "utf8");
      return ["POST", "PUT", "PATCH", "DELETE"].filter((m) => handlerCode(src, m, f));
    });
    expect(writes.length).toBeGreaterThan(100);
  });

  it("every write handler reaches a scope-enforcing gate", () => {
    expect(unscopedWrites()).toEqual([]);
  });

  it("catches a planted write that gates on bits alone, beside one that doesn't", () => {
    const ungated = `import { requirePermission } from "@/lib/rbac/check";
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  const { projectId } = await params;
  requirePermission(ctx, Permission.ITEM_DELETE);
  await prisma.workItem.deleteMany({ where: { projectId } });
}
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { projectId } = await params;
  await removeAll(projectId);
}
async function removeAll(projectId: string) {
  await requireProjectManage(ctx, projectId, Permission.ITEM_DELETE);
}`;
    expect(unscopedWritesIn([{ file: PLANTED, src: ungated }])).toEqual([
      "DELETE v1/orgs/[orgId]/projects/[projectId]/planted/route.ts",
    ]);
  });

  it("would catch a write that gates on bits alone", () => {
    expect(SCOPE_GATE.test(`requirePermission(ctx, Permission.ITEM_DELETE); await prisma.workItem.delete(...)`)).toBe(false);
    expect(SCOPE_GATE.test(`await requireAccess(ctx, "ITEM_DELETE");`)).toBe(false);
    expect(SCOPE_GATE.test(`await requireAccess(ctx, "ITEM_DELETE", { projectId, createdById });`)).toBe(true);
  });
});
