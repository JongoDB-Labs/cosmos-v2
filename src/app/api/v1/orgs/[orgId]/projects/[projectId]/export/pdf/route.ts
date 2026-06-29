import { NextRequest } from "next/server";
import { handleApiError } from "@/lib/api-helpers";
import {
  isLibreOfficeAvailable,
  xlsxToPdf,
  LibreOfficeUnavailableError,
} from "@/lib/office/libreoffice";
import {
  parseTrackers,
  resolveContext,
  buildCombinedWithCharts,
} from "@/lib/pm/export-shared";
import type { Tracker } from "@/lib/pm/template-export";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

/**
 * Project PM-dashboard PDF export.
 *
 * Builds the SAME combined workbook the xlsx route serves (every tab of every
 * selected tracker, with burn's charts injected when LibreOffice can validate
 * them) and renders it to a single PDF via headless LibreOffice.
 *
 * Honors the same `trackers`/`mode` params as the xlsx route (only `combined`
 * is meaningful for a single PDF; any value builds the combined book). Requires
 * ANALYTICS_READ, identical to xlsx. When LibreOffice is not configured on the
 * host, returns 503 with a clear JSON message rather than a broken download.
 */

const PDF_MIME = "application/pdf";

async function buildPdf(
  orgId: string,
  projectId: string,
  projectKey: string,
  trackers: Tracker[],
): Promise<Response> {
  if (!(await isLibreOfficeAvailable())) {
    return new Response(
      JSON.stringify({
        error: "pdf_export_unavailable",
        message:
          "PDF export requires LibreOffice, which is not available on this server. Export to Excel instead, or contact your administrator.",
      }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  // Combined workbook (charts injected + validated when burn is selected).
  const { buffer: xlsx } = await buildCombinedWithCharts(
    orgId,
    projectId,
    projectKey,
    trackers,
  );
  const pdf = await xlsxToPdf(xlsx);

  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": PDF_MIME,
      "Content-Disposition": `attachment; filename="${projectKey}-pm-dashboard.pdf"`,
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
    return await buildPdf(orgId, projectId, ctx.project.key, trackers);
  } catch (e) {
    // A LibreOffice failure mid-render is a 503, not a generic 500.
    if (e instanceof LibreOfficeUnavailableError) {
      return new Response(
        JSON.stringify({ error: "pdf_export_unavailable", message: e.message }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }
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
    };
    const trackers = parseTrackers(body.trackers);
    return await buildPdf(orgId, projectId, ctx.project.key, trackers);
  } catch (e) {
    if (e instanceof LibreOfficeUnavailableError) {
      return new Response(
        JSON.stringify({ error: "pdf_export_unavailable", message: e.message }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }
    return handleApiError(e);
  }
}
