import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { buildProjectWorkbook } from "@/lib/pm/export";
import { graphUploadFile } from "@/lib/integrations/microsoft-graph";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

type RouteParams = { params: Promise<{ orgId: string; projectId: string }> };

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Mirror the project workbook into the org's SharePoint document library via the
// Microsoft Graph app-only integration. Requires the Entra app to hold
// Sites.ReadWrite.All (or Sites.Selected) + admin consent, and the target
// site/drive configured on the integration.
export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ANALYTICS_READ);

    const project = await prisma.project.findFirst({
      where: { id: projectId, orgId },
      select: { key: true },
    });
    if (!project) return new Response("Not found", { status: 404 });

    // The SharePoint target (siteId/driveId/folder) lives in the M365
    // integration's non-secret config. Absent ⇒ a clear, actionable error.
    const integration = await prisma.integration.findFirst({
      where: { orgId, provider: "microsoft365" },
      select: { config: true },
    });
    const sp = ((integration?.config ?? {}) as Record<string, unknown>).sharePoint as
      | { siteId?: string; driveId?: string; folder?: string }
      | undefined;
    if (!sp?.siteId || !sp?.driveId) {
      return jsonError(
        "SharePoint mirroring isn't configured. Connect Microsoft 365 (an Entra app with Sites.ReadWrite.All + admin consent) and set config.sharePoint = { siteId, driveId, folder } on the integration.",
        400,
      );
    }

    const buf = await buildProjectWorkbook(orgId, projectId);
    const folder = sp.folder ? `${sp.folder.replace(/^\/+|\/+$/g, "")}/` : "";
    const filename = `${project.key}-pm-dashboard.xlsx`;
    const uploadPath = `/sites/${sp.siteId}/drives/${sp.driveId}/root:/${folder}${filename}:/content`;

    // A fresh ArrayBuffer holding exactly the workbook bytes (clean BodyInit).
    const body = new Uint8Array(buf).buffer;
    const result = await graphUploadFile(orgId, uploadPath, body, XLSX_MIME);
    if (!result.ok) return jsonError(result.error, 502);

    const webUrl = (result.data as { webUrl?: string } | null)?.webUrl ?? null;
    return success({ mirrored: true, filename, webUrl });
  } catch (e) {
    return handleApiError(e);
  }
}
