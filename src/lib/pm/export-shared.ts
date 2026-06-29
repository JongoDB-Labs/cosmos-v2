import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { buildCombinedWorkbook } from "@/lib/pm/combined-export";
import { isLibreOfficeAvailable, validateXlsx } from "@/lib/office/libreoffice";
import { TRACKERS, type Tracker } from "@/lib/pm/template-export";

/**
 * Shared building blocks for the PM-dashboard export routes (xlsx + pdf). Both
 * routes parse the same `trackers`/`mode` params, resolve the same org/project
 * under the same ANALYTICS_READ gate, and build the same combined workbook —
 * including the LibreOffice chart-validation dance — so that logic lives here
 * once rather than being duplicated (or one route importing the other).
 */

/** XLSX MIME type. */
export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/**
 * Normalize the `trackers` selection (comma string on GET, array on POST) to a
 * deduped, canonically-ordered Tracker[]. Empty/invalid input selects all eight.
 */
export function parseTrackers(
  raw: string | string[] | null | undefined,
): Tracker[] {
  if (raw == null) return [...TRACKERS];
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  const wanted = list.map((t) => t.trim().toLowerCase()).filter(Boolean);
  const valid = wanted.filter((t): t is Tracker =>
    (TRACKERS as readonly string[]).includes(t),
  );
  return valid.length ? [...new Set(valid)] : [...TRACKERS];
}

export type ResolvedContext =
  | { error: Response }
  | { project: { key: string } };

/**
 * Resolve the org + project for an export request and enforce ANALYTICS_READ.
 * Returns `{ error }` (a ready-to-return Response) on any miss, else `{ project }`.
 */
export async function resolveContext(
  orgId: string,
  projectId: string,
): Promise<ResolvedContext> {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return { error: new Response("Not found", { status: 404 }) };
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return { error: new Response("Unauthorized", { status: 401 }) };
  requirePermission(ctx, Permission.ANALYTICS_READ);
  const project = await prisma.project.findFirst({
    where: { id: projectId, orgId },
    select: { key: true },
  });
  if (!project) return { error: new Response("Not found", { status: 404 }) };
  return { project };
}

/**
 * Build the combined workbook, including burn's charts **only when it's both
 * possible and proven safe**:
 *
 *   1. Always build the clean, chartless merge first.
 *   2. If LibreOffice is available AND burn is in the selection, also build the
 *      chart-injected variant and render it to PDF (`validateXlsx`). Serve the
 *      charted bytes ONLY if that render succeeds.
 *   3. On any other condition (no LibreOffice, burn not selected, or a failed /
 *      corrupt render) serve the chartless bytes.
 *
 * An un-validated charted workbook is never returned. Returns the bytes plus a
 * `charts` flag for the caller's logging/telemetry.
 */
export async function buildCombinedWithCharts(
  orgId: string,
  projectId: string,
  projectKey: string,
  trackers: Tracker[],
): Promise<{ buffer: Buffer; charts: boolean }> {
  const noCharts = await buildCombinedWorkbook(
    orgId,
    projectId,
    projectKey,
    trackers,
  );

  const burnSelected = trackers.includes("burn");
  if (!burnSelected || !(await isLibreOfficeAvailable())) {
    return { buffer: noCharts, charts: false };
  }

  const charted = await buildCombinedWorkbook(
    orgId,
    projectId,
    projectKey,
    trackers,
    { withCharts: true },
  );
  const result = await validateXlsx(charted);
  // Serve charts only when the render-to-PDF gate confirms the file is sound.
  return result.ok
    ? { buffer: charted, charts: true }
    : { buffer: noCharts, charts: false };
}
