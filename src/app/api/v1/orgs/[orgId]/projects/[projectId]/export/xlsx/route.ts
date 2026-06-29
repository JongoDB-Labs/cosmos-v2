import { NextRequest } from "next/server";
import JSZip from "jszip";
import { handleApiError } from "@/lib/api-helpers";
import { buildPopulatedTemplate, type Tracker } from "@/lib/pm/template-export";
import {
  XLSX_MIME,
  parseTrackers,
  resolveContext,
  buildCombinedWithCharts,
} from "@/lib/pm/export-shared";

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
 *     Burn's 11 charts are grafted onto the merged BRN sheets WHEN a headless
 *     LibreOffice is present to validate the result (render-to-PDF); if it's
 *     absent or the render fails, a clean chartless workbook is served instead.
 *     An un-validated charted file is never returned.
 *
 * Selection comes from `trackers` (comma list on GET, array on POST) and `mode`.
 * Omitting `trackers` selects all eight.
 */

async function buildResponse(
  orgId: string,
  projectId: string,
  projectKey: string,
  trackers: Tracker[],
  mode: string,
): Promise<Response> {
  if (mode === "combined") {
    const { buffer } = await buildCombinedWithCharts(
      orgId,
      projectId,
      projectKey,
      trackers,
    );
    return new Response(new Uint8Array(buffer), {
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
