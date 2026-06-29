import { NextRequest } from "next/server";
import JSZip from "jszip";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { handleApiError } from "@/lib/api-helpers";
import { buildCombinedWorkbook } from "@/lib/pm/combined-export";
import {
  buildPopulatedTemplate,
  TRACKERS,
  type Tracker,
} from "@/lib/pm/template-export";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

/**
 * Project PM-dashboard export.
 *
 *   • mode=separate (default) → a ZIP of each selected tracker's fully-populated
 *     *template* file (full fidelity: styles, formulas, charts, validations).
 *   • mode=combined → ONE workbook (buildCombinedWorkbook) containing EVERY tab
 *     of every selected tracker — Instructions, data registers, summary
 *     dashboards, and burn's full 19-tab cascade — with styles, number formats,
 *     merges, frozen panes, and working cross-sheet formulas preserved (the
 *     Summary COUNTIF/SUMIF rollups and the burn cascade recompute on open).
 *     Charts are omitted; they live only in the separate files.
 *
 * Selection comes from `trackers` (comma list on GET, array on POST) and `mode`.
 * Omitting `trackers` selects all eight.
 */

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function parseTrackers(raw: string | string[] | null | undefined): Tracker[] {
  if (raw == null) return [...TRACKERS];
  const list = Array.isArray(raw) ? raw : String(raw).split(",");
  const wanted = list.map((t) => t.trim().toLowerCase()).filter(Boolean);
  const valid = wanted.filter((t): t is Tracker =>
    (TRACKERS as readonly string[]).includes(t),
  );
  return valid.length ? [...new Set(valid)] : [...TRACKERS];
}

async function resolveContext(orgId: string, projectId: string) {
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) return { error: new Response("Not found", { status: 404 }) } as const;
  const ctx = await getAuthContext(org.slug);
  if (!ctx) return { error: new Response("Unauthorized", { status: 401 }) } as const;
  requirePermission(ctx, Permission.ANALYTICS_READ);
  const project = await prisma.project.findFirst({
    where: { id: projectId, orgId },
    select: { key: true },
  });
  if (!project) return { error: new Response("Not found", { status: 404 }) } as const;
  return { project } as const;
}

async function buildResponse(
  orgId: string,
  projectId: string,
  projectKey: string,
  trackers: Tracker[],
  mode: string,
): Promise<Response> {
  if (mode === "combined") {
    const buf = await buildCombinedWorkbook(orgId, projectId, projectKey, trackers);
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": XLSX_MIME,
        "Content-Disposition": `attachment; filename="${projectKey}-pm-dashboard.xlsx"`,
      },
    });
  }

  // separate → ZIP of populated template files
  if (trackers.length === 1) {
    // A single tracker needs no zip — return the .xlsx directly.
    const { buffer, filename } = await buildPopulatedTemplate(
      trackers[0], orgId, projectId, projectKey,
    );
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": XLSX_MIME,
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  const zip = new JSZip();
  for (const tracker of trackers) {
    const { buffer, filename } = await buildPopulatedTemplate(
      tracker, orgId, projectId, projectKey,
    );
    zip.file(filename, buffer);
  }
  const zipBuf = await zip.generateAsync({ type: "nodebuffer" });
  return new Response(new Uint8Array(zipBuf), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${projectKey}-pm-trackers.zip"`,
    },
  });
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const ctx = await resolveContext(orgId, projectId);
    if ("error" in ctx) return ctx.error;
    const url = new URL(request.url);
    const trackers = parseTrackers(url.searchParams.get("trackers"));
    const mode = url.searchParams.get("mode") ?? "separate";
    return await buildResponse(orgId, projectId, ctx.project.key, trackers, mode);
  } catch (e) {
    return handleApiError(e);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const ctx = await resolveContext(orgId, projectId);
    if ("error" in ctx) return ctx.error;
    const body = (await request.json().catch(() => ({}))) as {
      trackers?: string[] | string;
      mode?: string;
    };
    const trackers = parseTrackers(body.trackers);
    const mode = body.mode ?? "separate";
    return await buildResponse(orgId, projectId, ctx.project.key, trackers, mode);
  } catch (e) {
    return handleApiError(e);
  }
}
