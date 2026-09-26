import { NextRequest } from "next/server";
import { z } from "zod";
import { getAuthContext } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { requirePermission, NotFoundError, ConflictError } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { availableEntityDefs, type EntityImportRequest } from "@/lib/import/entity-fields";
import { mapRows, codeKeyError } from "@/lib/import/entity-import";
import { PluginRegistry, PluginServerRegistry } from "@/lib/plugins/registry";
import { getEnabledPluginSlugs } from "@/lib/plugins/enablement";

const MAX_ROWS = 5000;
const MAX_CELL = 20_000;

/**
 * ORG-WIDE import of records from another system.
 *
 * The sibling route under /projects/[projectId]/import imports INTO one open
 * project. An export from another system is not shaped that way: it carries
 * every project at once, keyed by that system's own ids, and may name projects
 * this org has never heard of. So this route is scoped to the org and refuses
 * anything that expects a project context.
 *
 * `mode` is the whole contract: "validate" reports what would happen and
 * writes nothing, "commit" does the same work and keeps it. Both run the same
 * code, which is what lets the preview be trusted.
 */
const importSchema = z.object({
  entity: z.string().min(1).max(64),
  mode: z.enum(["validate", "commit"]),
  mapping: z.record(z.string(), z.string()),
  rows: z
    .array(z.record(z.string(), z.union([z.string().max(MAX_CELL), z.number(), z.null()])))
    .max(MAX_ROWS),
});

type RouteParams = { params: Promise<{ orgId: string }> };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findFirst({
      where: UUID_RE.test(orgId) ? { id: orgId } : { slug: { equals: orgId, mode: "insensitive" } },
      select: { id: true, slug: true },
    });
    if (!org) throw new NotFoundError("Organization not found");

    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_IMPORT);

    const req = importSchema.parse(await request.json()) as EntityImportRequest;

    // Only entities the org can actually run: core's, plus those from plugins
    // this org has switched on. A disabled plugin's writer is not registered,
    // so offering its entity would fail after the reader had done the mapping.
    const enabled = await getEnabledPluginSlugs(org.id);
    const def = availableEntityDefs(PluginRegistry.getAll(), enabled).find((e) => e.key === req.entity);
    if (!def) throw new NotFoundError(`Unknown import type "${req.entity}"`);
    if (def.scope !== "org") {
      throw new ConflictError(
        `"${def.label}" imports into a single project — use that project's import instead.`,
      );
    }

    // Shared coercion: the same mapping the project-scoped import runs, so a
    // date or a number means the same thing whichever door it came through.
    const mapped = mapRows(def, req);
    const errors: { row: number; message: string }[] = [];
    const ready: Record<string, unknown>[] = [];
    let skipped = 0;
    for (const m of mapped) {
      const err = m.error ?? codeKeyError(def, m.fields);
      for (const w of m.warnings) errors.push({ row: m.rowNum, message: w });
      if (err) {
        errors.push({ row: m.rowNum, message: err });
        skipped += 1;
        continue;
      }
      ready.push(m.fields);
    }

    // Core declares no org-scoped entities yet; every one of them today comes
    // from a plugin, which is also where the writer lives.
    const writer = def.pluginSlug
      ? PluginServerRegistry.get(def.pluginSlug)?.importWriters?.[def.key]
      : undefined;
    if (!writer) {
      throw new ConflictError(`No importer is registered for "${def.label}".`);
    }

    const result = await writer({
      prisma,
      orgId: org.id,
      userId: ctx.userId,
      rows: ready,
      commit: req.mode === "commit",
    });

    return success({
      total: mapped.length,
      willCreate: result.created,
      willUpdate: result.updated,
      skipped: skipped + result.skipped,
      errors: [...errors, ...result.errors],
      ...(req.mode === "commit" ? { created: result.created, updated: result.updated } : {}),
    });
  } catch (err) {
    return handleApiError(err);
  }
}
