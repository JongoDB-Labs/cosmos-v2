import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { handleApiError, success } from "@/lib/api-helpers";
import { parseRequest } from "@/lib/openapi/respond";
import { workflowProjectContext } from "@/lib/workflow/route-auth.server";
import { requireProjectManage } from "@/lib/rbac/require-project-manage";
import { Permission } from "@/lib/rbac/permissions";
import { discardDraft, saveDraft, type VersionLayout } from "@/lib/workflow/versions.server";
import { discardWorkflowDraft, saveWorkflowDraft } from "./route.contract";

type RouteParams = { params: Promise<{ orgId: string; projectId: string; workflowId: string }> };

// Autosave: not audited per keystroke. The publish is the audited act.
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p, body } = await parseRequest(saveWorkflowDraft, request, params);
    const ctx = await workflowProjectContext(p, saveWorkflowDraft);
    await requireProjectManage(ctx, p.projectId, Permission.WORKFLOW_MANAGE);
    const saved = await prisma.$transaction((tx) =>
      saveDraft(tx, { orgId: p.orgId, projectId: p.projectId }, p.workflowId, {
        definition: body.definition,
        layout: body.layout as VersionLayout | undefined,
      }),
    );
    return success(saved);
  } catch (error) {
    return handleApiError(error, request);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { params: p } = await parseRequest(discardWorkflowDraft, request, params);
    const ctx = await workflowProjectContext(p, discardWorkflowDraft);
    await requireProjectManage(ctx, p.projectId, Permission.WORKFLOW_MANAGE);
    await prisma.$transaction((tx) => discardDraft(tx, { orgId: p.orgId, projectId: p.projectId }, p.workflowId));
    return success({ ok: true as const });
  } catch (error) {
    return handleApiError(error, request);
  }
}
