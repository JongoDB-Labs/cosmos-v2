import { prisma } from "@/lib/db/client";
import { getAuthContext } from "@/lib/auth/session";
import { requirePermission } from "@/lib/rbac/check";
import { Permission } from "@/lib/rbac/permissions";
import { success, handleApiError } from "@/lib/api-helpers";
import { computeLoopMetrics, type LoopStateRow, type LoopTransitionRow } from "@/lib/foreman/loop/metrics";

/**
 * Read-only convergence-metrics surface for Foreman's loop-graph (Phase 4):
 * aggregates the durable loop-state + loop-transition rows into the four
 * headline metrics (convergence rate, iterations-to-converge,
 * invariant-violation rate, cost-per-convergence) via the pure core in
 * lib/foreman/loop/metrics.ts. Same ORG_UPDATE steering gate as the rest of
 * the console's read surface.
 */
type RouteParams = { params: Promise<{ orgId: string }> };

export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true, slug: true },
    });
    if (!org) return new Response("Not found", { status: 404 });
    const ctx = await getAuthContext(org.slug);
    if (!ctx) return new Response("Unauthorized", { status: 401 });
    requirePermission(ctx, Permission.ORG_UPDATE);

    const [states, transitions] = await Promise.all([
      prisma.foremanLoopState.findMany({
        where: { orgId },
        select: { loopId: true, status: true, iteration: true },
      }),
      prisma.foremanLoopTransition.findMany({
        where: { orgId },
        select: {
          loopId: true,
          iteration: true,
          toPhase: true,
          terminationSignal: true,
          invariantResults: true,
          costUsd: true,
        },
      }),
    ]);

    const metrics = computeLoopMetrics(
      states as LoopStateRow[],
      transitions as unknown as LoopTransitionRow[],
    );

    // Phase 5 shadow: how often the convergence contract would have terminated a
    // loop the daemon was still progressing (recorded by loop-io in shadow/live).
    // 0 = the engine agrees with reality — the gate to trust before it drives (Phase 6).
    const shadowDivergences = (
      await prisma.foremanEvent.findMany({
        where: { orgId, kind: "loop_shadow_divergence" },
        distinct: ["workItemId"],
        select: { workItemId: true },
      })
    ).length; // distinct LOOPS, not transitions — the card reads it as loops
    return success({ metrics, shadowDivergences });
  } catch (error) {
    return handleApiError(error);
  }
}
