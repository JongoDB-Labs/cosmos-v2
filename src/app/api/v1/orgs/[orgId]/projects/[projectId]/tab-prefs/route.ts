import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { Prisma } from "@prisma/client";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Per-user tab tailoring for a project. Every key is optional — the client
// PUTs only the slice it changed (e.g. `{ tabOrder }`), and we shallow-merge it
// into the caller's `tabPrefs[projectId]` so untouched keys (and other
// projects' entries) survive. Board NAMES are NOT here — a rename mutates the
// shared board row; only the per-user view (order / hidden / default / labels)
// lives in this store.
const tabPrefsSchema = z.object({
  tabOrder: z.array(z.string()).optional(),
  hiddenBoardIds: z.array(z.string()).optional(),
  hiddenFeatureTabs: z.array(z.string()).optional(),
  featureTabLabels: z.record(z.string(), z.string()).optional(),
  // Nullable so a user can CLEAR their own default (fall back to the project's).
  defaultTab: z.string().nullish(),
});

/**
 * PUT /api/v1/orgs/[orgId]/projects/[projectId]/tab-prefs
 *
 * Save the CALLER'S OWN per-project tab layout (order / hidden tabs / default /
 * feature-tab labels). Any authenticated member who can READ the project may
 * call it — this is a personal-view pref, NOT a manager-only project setting
 * (those still go through PUT …/projects/[projectId] `settings`).
 *
 * Merge semantics: `tabPrefs` is `{ [projectId]: { …keys } }`. We shallow-merge
 * the validated patch INTO the existing `tabPrefs[projectId]`, so a partial PUT
 * like `{ tabOrder }` replaces only that key while keeping this project's other
 * keys and every OTHER project's entry intact. Returns the updated per-project
 * prefs object.
 */
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;

    // Resolve the org by id (the client sends the ctx.orgId UUID) or by slug as
    // a fallback, mirroring the insensitive match sibling routes tolerate.
    const org = await prisma.organization.findFirst({
      where: UUID_RE.test(orgId)
        ? { id: orgId }
        : { slug: { equals: orgId, mode: "insensitive" } },
      select: { id: true, slug: true },
    });
    if (!org) return new Response("Not found", { status: 404 });

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    // Any member who can READ the project may tailor their OWN view.
    requirePermission(ctx, Permission.PROJECT_READ);

    // Resolve the project within this org by id or (insensitive) key.
    const project = await prisma.project.findFirst({
      where: {
        orgId: org.id,
        ...(UUID_RE.test(projectId)
          ? { id: projectId }
          : { key: { equals: projectId, mode: "insensitive" } }),
        archived: false,
      },
      select: { id: true },
    });
    if (!project) return new Response("Not found", { status: 404 });

    const body = await request.json();
    const patch = tabPrefsSchema.parse(body);

    // Load the caller's existing prefs so we can merge (upsert can't read the
    // current JSON value to merge against).
    const existing = await prisma.userPreferences.findUnique({
      where: { userId: ctx.userId },
      select: { tabPrefs: true },
    });

    const allPrefs =
      existing?.tabPrefs && typeof existing.tabPrefs === "object" && !Array.isArray(existing.tabPrefs)
        ? (existing.tabPrefs as Record<string, unknown>)
        : {};

    const current =
      allPrefs[project.id] &&
      typeof allPrefs[project.id] === "object" &&
      !Array.isArray(allPrefs[project.id])
        ? (allPrefs[project.id] as Record<string, unknown>)
        : {};

    // Shallow-merge only the provided keys into THIS project's slice; keep the
    // project's untouched keys + all other projects' entries.
    const mergedProject: Record<string, unknown> = { ...current };
    if (patch.tabOrder !== undefined) mergedProject.tabOrder = patch.tabOrder;
    if (patch.hiddenBoardIds !== undefined) mergedProject.hiddenBoardIds = patch.hiddenBoardIds;
    if (patch.hiddenFeatureTabs !== undefined) mergedProject.hiddenFeatureTabs = patch.hiddenFeatureTabs;
    if (patch.featureTabLabels !== undefined) mergedProject.featureTabLabels = patch.featureTabLabels;
    if (patch.defaultTab !== undefined) mergedProject.defaultTab = patch.defaultTab;

    const nextPrefs = { ...allPrefs, [project.id]: mergedProject };

    await prisma.userPreferences.upsert({
      where: { userId: ctx.userId },
      create: {
        userId: ctx.userId,
        tabPrefs: nextPrefs as Prisma.InputJsonValue,
      },
      update: {
        tabPrefs: nextPrefs as Prisma.InputJsonValue,
      },
    });

    return success(mergedProject);
  } catch (error) {
    return handleApiError(error);
  }
}
